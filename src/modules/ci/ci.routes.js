// The API a CI pipeline calls:
//
//   POST /api/v1/runs        start a run (by prompt/suite/provider *name*)
//   GET  /api/v1/runs/:id    poll until gate.status is "passed" or "failed"
//
// Names instead of UUIDs, because a workflow file should say
// `prompt: support-triage`, not a random id.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parse } from '../../lib/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireUuidParams } from '../../lib/params.js';
import { requireApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as runs from '../runs/runs.service.js';

const startSchema = z.object({
  prompt: z.string().trim().min(1),
  version: z.number().int().positive().optional(), // default: latest
  suite: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  // "previous": the latest completed run of an earlier version of this prompt.
  baseline: z.union([z.literal('previous'), z.uuid()]).nullish(),
  useCache: z.boolean().default(true),
});

async function resolveNames(projectId, input) {
  const [prompt, suite, provider] = await Promise.all([
    prisma.prompt.findUnique({ where: { projectId_name: { projectId, name: input.prompt } } }),
    prisma.suite.findUnique({ where: { projectId_name: { projectId, name: input.suite } } }),
    prisma.providerConfig.findUnique({ where: { projectId_name: { projectId, name: input.provider } } }),
  ]);
  if (!prompt) throw notFound(`Prompt "${input.prompt}"`);
  if (!suite) throw notFound(`Suite "${input.suite}"`);
  if (!provider) throw notFound(`Provider "${input.provider}"`);

  const version = await prisma.promptVersion.findUnique({
    where: { promptId_version: { promptId: prompt.id, version: input.version ?? prompt.latestVersion } },
  });
  if (!version) throw notFound(`Version ${input.version} of prompt "${input.prompt}"`);

  let baselineRunId = null;
  if (input.baseline === 'previous') {
    const previous = await runs.findPreviousRun(projectId, {
      promptId: prompt.id,
      promptVersionId: version.id,
      suiteId: suite.id,
      providerConfigId: provider.id,
    });
    baselineRunId = previous?.id ?? null; // first ever run: no baseline, every case must pass
  } else if (input.baseline) {
    baselineRunId = input.baseline;
  }

  return {
    promptVersionId: version.id,
    suiteId: suite.id,
    providerConfigId: provider.id,
    baselineRunId,
    useCache: input.useCache,
  };
}

function ciView(run) {
  return {
    id: run.id,
    status: run.status,
    prompt: run.promptVersion.prompt.name,
    version: run.promptVersion.version,
    suite: run.suite.name,
    provider: run.providerConfig.name,
    baselineRunId: run.baselineRunId,
    totals: {
      cases: run.totalCases,
      passed: run.passedCases,
      failed: run.failedCases,
      errored: run.erroredCases,
      cached: run.cachedCases,
      costUsd: run.costUsd,
    },
    progress: run.progress,
    comparison: run.comparison,
    gate: run.gate,
  };
}

export const ciRouter = Router();
requireUuidParams(ciRouter, 'runId');

ciRouter.use(requireApiKey);
ciRouter.use(rateLimit({ name: 'ci', limit: 120, windowSeconds: 60, keyFn: (req) => req.apiKey.id }));

ciRouter.post('/runs', async (req, res) => {
  const idempotencyKey = req.get('idempotency-key') ?? null;
  if (idempotencyKey !== null && !/^[\w.:-]{1,200}$/.test(idempotencyKey)) {
    throw badRequest('Idempotency-Key must be 1-200 characters of letters, digits, . _ : -');
  }
  const input = await resolveNames(req.project.id, parse(startSchema, req.body));
  const { run, created } = await runs.createRun(req.project.id, input, {
    trigger: 'API_KEY',
    idempotencyKey,
  });
  if (!created) res.set('Idempotent-Replayed', 'true');
  const full = await runs.getRun(req.project.id, run.id, { includeCases: false });
  res.status(created ? 202 : 200).json({ run: ciView(full) });
});

ciRouter.get('/runs/:runId', async (req, res) => {
  const run = await runs.getRun(req.project.id, req.params.runId);
  const notPassing = run.cases
    .filter((c) => c.status === 'FAILED' || c.status === 'ERROR')
    .map((c) => ({ name: c.caseName, status: c.status, error: c.error }));
  res.json({ run: { ...ciView(run), notPassing } });
});
