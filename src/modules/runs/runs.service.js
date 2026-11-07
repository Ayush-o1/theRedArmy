import { prisma } from '../../db.js';
import { sha256 } from '../../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { tryFinalizeRun } from '../../engine/queue.js';
import { compareCases, evaluateGate } from './compare.js';

const runSummaryInclude = {
  promptVersion: { select: { id: true, version: true, prompt: { select: { id: true, name: true } } } },
  suite: { select: { id: true, name: true } },
  providerConfig: { select: { id: true, name: true, kind: true, model: true } },
};

// Stable hash of the parts of a request that define the run, used to detect an
// Idempotency-Key being reused for a *different* request.
export function hashRunRequest(input) {
  const { promptVersionId, suiteId, providerConfigId, baselineRunId = null, useCache } = input;
  return sha256(JSON.stringify({ promptVersionId, suiteId, providerConfigId, baselineRunId, useCache }));
}

async function findByIdempotencyKey(projectId, idempotencyKey, requestHash) {
  const existing = await prisma.run.findUnique({
    where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
  });
  if (existing && existing.requestHash !== requestHash) {
    throw unprocessable('Idempotency-Key was already used with a different request body');
  }
  return existing;
}

/**
 * Creates a run and enqueues one job per test case, in a single transaction.
 *
 * Either the run and all of its jobs exist, or none of them do. A worker can
 * never see a half-created run, and a crash cannot leave a run with no jobs.
 *
 * Returns { run, created }. `created` is false when an Idempotency-Key matched
 * an earlier request; that earlier run is returned instead of a duplicate.
 */
export async function createRun(
  projectId,
  input,
  { trigger = 'USER', userId = null, idempotencyKey = null } = {},
) {
  const requestHash = idempotencyKey ? hashRunRequest(input) : null;
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(projectId, idempotencyKey, requestHash);
    if (existing) return { run: existing, created: false };
  }

  try {
    const run = await prisma.$transaction(async (tx) => {
      // Every referenced id must belong to this project. Without these checks a
      // user could run their prompt against another tenant's suite or provider.
      const [promptVersion, suite, provider, baseline] = await Promise.all([
        tx.promptVersion.findFirst({ where: { id: input.promptVersionId, prompt: { projectId } } }),
        tx.suite.findFirst({ where: { id: input.suiteId, projectId }, include: { cases: true } }),
        tx.providerConfig.findFirst({ where: { id: input.providerConfigId, projectId } }),
        input.baselineRunId ? tx.run.findFirst({ where: { id: input.baselineRunId, projectId } }) : null,
      ]);
      if (!promptVersion) throw notFound('Prompt version');
      if (!suite) throw notFound('Suite');
      if (!provider) throw notFound('Provider');
      if (input.baselineRunId && !baseline) throw notFound('Baseline run');
      if (suite.cases.length === 0) throw unprocessable('The suite has no test cases');

      return tx.run.create({
        data: {
          projectId,
          promptVersionId: promptVersion.id,
          suiteId: suite.id,
          providerConfigId: provider.id,
          baselineRunId: baseline?.id ?? null,
          useCache: input.useCache,
          trigger,
          createdById: userId,
          idempotencyKey,
          requestHash,
          totalCases: suite.cases.length,
          // Snapshot each case. Later edits to the suite do not rewrite history.
          cases: {
            createMany: {
              data: suite.cases.map((c) => ({
                testCaseId: c.id,
                caseName: c.name,
                variables: c.variables,
                assertions: c.assertions,
              })),
            },
          },
        },
      });
    });
    return { run, created: true };
  } catch (err) {
    // Two requests with the same Idempotency-Key raced past the lookup above.
    // The unique index let exactly one insert win; return the winner's run.
    if (err.code === 'P2002' && idempotencyKey) {
      const existing = await findByIdempotencyKey(projectId, idempotencyKey, requestHash);
      if (existing) return { run: existing, created: false };
    }
    throw err;
  }
}

/**
 * Keyset ("cursor") pagination ordered by (createdAt, id) descending.
 * Unlike OFFSET, it stays fast on deep pages and does not skip or repeat rows
 * when new runs are inserted while someone is paging.
 */
export async function listRuns(projectId, { limit, cursor, promptId, suiteId, status }) {
  const where = {
    projectId,
    ...(status ? { status } : {}),
    ...(suiteId ? { suiteId } : {}),
    ...(promptId ? { promptVersion: { promptId } } : {}),
  };
  const runs = await prisma.run.findMany({
    where,
    include: runSummaryInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1, // fetch one extra to know whether another page exists
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = runs.length > limit;
  const page = hasMore ? runs.slice(0, limit) : runs;
  return { runs: page, nextCursor: hasMore ? page.at(-1).id : null };
}

async function findRun(projectId, runId, include) {
  const run = await prisma.run.findFirst({ where: { id: runId, projectId }, include });
  if (!run) throw notFound('Run');
  return run;
}

// The stored totals are written when the run finishes. While it is running,
// count live from run_cases so the UI can show progress.
async function liveProgress(runId) {
  const groups = await prisma.runCase.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } });
  return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
}

export async function getRunCases(runId) {
  return prisma.runCase.findMany({
    where: { runId },
    orderBy: { caseName: 'asc' },
    select: {
      id: true,
      testCaseId: true,
      caseName: true,
      variables: true,
      assertions: true,
      status: true,
      attempts: true,
      renderedPrompt: true,
      output: true,
      assertionResults: true,
      error: true,
      cacheHit: true,
      latencyMs: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
    },
  });
}

export async function getRun(projectId, runId, { includeCases = true } = {}) {
  const run = await findRun(projectId, runId, {
    ...runSummaryInclude,
    promptVersion: { include: { prompt: { select: { id: true, name: true } } } },
  });
  const [progress, cases, comparison] = await Promise.all([
    liveProgress(run.id),
    includeCases ? getRunCases(run.id) : null,
    run.baselineRunId ? compareRunIds(projectId, run.baselineRunId, run.id).then((c) => c.summary) : null,
  ]);
  const gate = evaluateGate(run, comparison ? { summary: comparison } : null);
  return { ...run, progress, comparison, gate, ...(includeCases ? { cases } : {}) };
}

async function compareRunIds(projectId, baseId, headId) {
  const [base, head] = await Promise.all([
    findRun(projectId, baseId, { cases: true }),
    findRun(projectId, headId, { cases: true }),
  ]);
  return compareCases(base.cases, head.cases);
}

export async function compareRuns(projectId, baseId, headId) {
  const [base, head] = await Promise.all([
    findRun(projectId, baseId, runSummaryInclude),
    findRun(projectId, headId, runSummaryInclude),
  ]);
  const comparison = await compareRunIds(projectId, baseId, headId);
  const warnings = [];
  if (base.suiteId !== head.suiteId)
    warnings.push('The runs used different suites; only cases with matching ids are compared.');
  return { base, head, warnings, ...comparison };
}

export async function cancelRun(projectId, runId) {
  await findRun(projectId, runId);
  const cancelled = await prisma.$transaction(async (tx) => {
    const { count } = await tx.run.updateMany({
      where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) return false;
    // Jobs already running are left to finish (their results are still useful);
    // jobs still waiting will never start.
    await tx.runCase.updateMany({
      where: { runId, status: 'PENDING' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    return true;
  });
  if (!cancelled) throw conflict('Run has already finished');
  await tryFinalizeRun(runId);
  return getRun(projectId, runId, { includeCases: false });
}

export async function deleteRun(projectId, runId) {
  const run = await findRun(projectId, runId);
  if (run.status === 'QUEUED' || run.status === 'RUNNING') {
    throw conflict('Cancel the run before deleting it');
  }
  await prisma.run.delete({ where: { id: runId } });
}

/**
 * Finds the most recent completed run of the same prompt, suite and provider,
 * excluding the given prompt version. CI uses this as "compare with whatever
 * we had before this change".
 */
export async function findPreviousRun(projectId, { promptId, promptVersionId, suiteId, providerConfigId }) {
  return prisma.run.findFirst({
    where: {
      projectId,
      suiteId,
      providerConfigId,
      status: 'COMPLETED',
      promptVersion: { promptId },
      promptVersionId: { not: promptVersionId },
    },
    orderBy: { createdAt: 'desc' },
  });
}
