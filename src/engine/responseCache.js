// Exact-match cache of model responses, stored in Postgres.
//
// Why: re-running a suite after editing one case should not pay to re-run the
// other 99. Cost is a documented reason teams stop automating LLM tests.
//
// Why exact match and not "semantic" (embedding-similarity) caching? Semantic
// caches can return the answer to a *similar* prompt, and false hits are a
// known failure mode. For a testing tool, a wrong cached answer is worse than
// no cache, so the key covers everything that can change the output.
//
// Why Postgres and not Redis? The cache saves money, so it should survive a
// restart, and it is read once per job, which is not a hot path.
import { prisma } from '../db.js';
import { sha256 } from '../lib/crypto.js';

export function cacheKey({ projectId, providerConfig, promptVersion, renderedPrompt }) {
  // The project id is part of the key so tenants never share entries.
  return sha256(
    JSON.stringify([
      projectId,
      providerConfig.kind,
      providerConfig.baseUrl ?? '',
      providerConfig.model,
      // Simulator settings change its output, so they must be in the key too.
      providerConfig.kind === 'SIMULATED' ? providerConfig.settings : null,
      promptVersion.systemPrompt,
      renderedPrompt,
      promptVersion.temperature,
      promptVersion.maxTokens,
    ]),
  );
}

// Sampling with temperature > 0 is intentionally random. Caching it would hide
// the very variance a regression test should surface.
export function isCacheable(run, promptVersion) {
  return run.useCache && promptVersion.temperature === 0;
}

export async function getCached(key) {
  const entry = await prisma.cachedResponse.findUnique({ where: { key } });
  if (!entry) return null;
  // Best-effort statistic; a lost increment is harmless.
  prisma.cachedResponse.update({ where: { key }, data: { hitCount: { increment: 1 } } }).catch(() => {});
  return entry;
}

export async function putCached(key, projectId, { output, inputTokens, outputTokens }) {
  // Two workers may compute the same prompt at once. skipDuplicates turns the
  // second insert into a no-op instead of a unique-constraint error.
  await prisma.cachedResponse.createMany({
    data: [{ key, projectId, output, inputTokens, outputTokens }],
    skipDuplicates: true,
  });
}
