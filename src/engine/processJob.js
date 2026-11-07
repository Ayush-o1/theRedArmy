// Executes one claimed job (one test case within a run).
//
//   load context -> render prompt -> cache? -> rate limit -> call provider
//     -> evaluate assertions -> store result -> maybe finalize the run
//
// Every exit path ends in exactly one of: completeJob (terminal result),
// rescheduleJob (try again later), or "lost the lease" (do nothing).
import { prisma } from '../db.js';
import { config } from '../config.js';
import { evaluateAssertions } from './assertions.js';
import { computeBackoffMs } from './backoff.js';
import { createProvider, estimateCostUsd } from './providers/index.js';
import { ProviderError } from './providers/providerError.js';
import { takeProviderToken } from './rateLimiter.js';
import { cacheKey, getCached, isCacheable, putCached } from './responseCache.js';
import { completeJob, markRunStarted, rescheduleJob, tryFinalizeRun } from './queue.js';
import { renderTemplate, TemplateError } from './template.js';

const truncate = (text, max = 1000) => (text.length > max ? `${text.slice(0, max)}…` : text);

export async function processJob(job, { workerId, log }) {
  const runCase = await prisma.runCase.findUnique({
    where: { id: job.id },
    include: { run: { include: { promptVersion: true, providerConfig: true } } },
  });
  const { run } = runCase;
  const { promptVersion, providerConfig } = run;
  const jobLog = log.child({ jobId: job.id, runId: run.id, attempt: job.attempts });

  await markRunStarted(run.id);

  // The run may have been cancelled after this job was claimed.
  if (run.status === 'CANCELLED') {
    await completeJob(job.id, workerId, { status: 'CANCELLED' });
    return finalize(run.id, jobLog);
  }

  let renderedPrompt;
  try {
    renderedPrompt = renderTemplate(promptVersion.template, runCase.variables);
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    await completeJob(job.id, workerId, { status: 'ERROR', error: err.message });
    return finalize(run.id, jobLog);
  }

  const useCache = isCacheable(run, promptVersion);
  const key = useCache
    ? cacheKey({ projectId: run.projectId, providerConfig, promptVersion, renderedPrompt })
    : null;
  const cached = useCache ? await getCached(key) : null;

  let result;
  let latencyMs = null;
  if (cached) {
    result = { output: cached.output, inputTokens: cached.inputTokens, outputTokens: cached.outputTokens };
  } else {
    // Ask the shared token bucket before calling the provider. If we must wait,
    // release the job rather than sleeping while holding it. This does not use
    // up an attempt, because the provider was never contacted.
    let waitMs;
    try {
      waitMs = await takeProviderToken(providerConfig.id, providerConfig.requestsPerMinute);
    } catch (err) {
      // Redis is down. Fail closed: calling the provider without the shared
      // limit could exceed its quota for every tenant. Try again shortly.
      jobLog.warn({ err: err.message }, 'rate limiter unavailable, rescheduling');
      await rescheduleJob(job.id, workerId, { delayMs: 5000, countAttempt: false });
      return;
    }
    if (waitMs > 0) {
      jobLog.debug({ waitMs }, 'rate limited locally, rescheduling');
      await rescheduleJob(job.id, workerId, { delayMs: waitMs, countAttempt: false });
      return;
    }

    const provider = createProvider(providerConfig);
    const started = Date.now();
    try {
      result = await provider.complete({
        systemPrompt: promptVersion.systemPrompt,
        prompt: renderedPrompt,
        temperature: promptVersion.temperature,
        maxTokens: promptVersion.maxTokens,
        attempt: job.attempts,
        signal: AbortSignal.timeout(config.PROVIDER_TIMEOUT_MS),
      });
      latencyMs = Date.now() - started;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return handleProviderError(err, { job, workerId, runId: run.id, log: jobLog });
    }
    if (useCache) await putCached(key, run.projectId, result);
  }

  const evaluation = evaluateAssertions(runCase.assertions, result.output, {
    latencyMs,
    cacheHit: Boolean(cached),
  });
  // A cache hit costs nothing: record zero cost so run totals reflect real spend.
  const costUsd = cached ? 0 : estimateCostUsd(providerConfig, result.inputTokens, result.outputTokens);

  const owned = await completeJob(job.id, workerId, {
    status: evaluation.passed ? 'PASSED' : 'FAILED',
    renderedPrompt,
    output: result.output,
    assertionResults: evaluation.results,
    error: null,
    cacheHit: Boolean(cached),
    latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
  });
  if (!owned) {
    jobLog.warn('lease lost before result was saved; result discarded');
    return;
  }
  jobLog.info(
    { status: evaluation.passed ? 'PASSED' : 'FAILED', cacheHit: Boolean(cached), latencyMs },
    'job done',
  );
  return finalize(run.id, jobLog);
}

async function handleProviderError(err, { job, workerId, runId, log }) {
  const message = truncate(err.message);
  if (err.retryable && job.attempts < job.maxAttempts) {
    const delayMs = computeBackoffMs(job.attempts, { retryAfterMs: err.retryAfterMs });
    log.warn({ status: err.status, delayMs, err: message }, 'transient provider error, retrying');
    await rescheduleJob(job.id, workerId, { delayMs, error: message });
    return;
  }
  log.warn({ status: err.status, err: message }, 'provider error, giving up');
  const owned = await completeJob(job.id, workerId, {
    status: 'ERROR',
    error: err.retryable ? `Gave up after ${job.attempts} attempts: ${message}` : message,
  });
  if (owned) await finalize(runId, log);
}

async function finalize(runId, log) {
  if (await tryFinalizeRun(runId)) log.info('run finalized');
}
