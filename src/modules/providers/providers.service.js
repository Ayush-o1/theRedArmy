import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { encrypt } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { assertSafeProviderUrl, UnsafeUrlError } from '../../engine/providers/urlGuard.js';

// The API never returns the stored key, only whether one exists and its last
// four characters, so users can tell keys apart.
export function toPublicProvider(p) {
  const { apiKeyCiphertext, ...rest } = p;
  return { ...rest, hasApiKey: Boolean(apiKeyCiphertext) };
}

async function checkBaseUrl(kind, baseUrl) {
  if (kind !== 'OPENAI_COMPATIBLE') return;
  if (!baseUrl) throw badRequest('baseUrl is required for OPENAI_COMPATIBLE providers');
  try {
    await assertSafeProviderUrl(baseUrl, { allowPrivate: config.ALLOW_PRIVATE_PROVIDER_URLS });
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw badRequest(err.message);
    throw err;
  }
}

function keyFields(apiKey) {
  if (apiKey === undefined) return {};
  if (apiKey === null || apiKey === '') return { apiKeyCiphertext: null, apiKeyLast4: null };
  return { apiKeyCiphertext: encrypt(apiKey), apiKeyLast4: apiKey.slice(-4) };
}

function handleUnique(err) {
  if (err.code === 'P2002') throw conflict('A provider with this name already exists in the project');
  throw err;
}

export async function listProviders(projectId) {
  const rows = await prisma.providerConfig.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  return rows.map(toPublicProvider);
}

export async function getProvider(projectId, providerId) {
  const provider = await prisma.providerConfig.findFirst({ where: { id: providerId, projectId } });
  if (!provider) throw notFound('Provider');
  return provider;
}

export async function createProvider(projectId, { apiKey, ...input }) {
  await checkBaseUrl(input.kind, input.baseUrl);
  const created = await prisma.providerConfig
    .create({ data: { ...input, projectId, ...keyFields(apiKey) } })
    .catch(handleUnique);
  return toPublicProvider(created);
}

export async function updateProvider(projectId, providerId, { apiKey, ...input }) {
  const existing = await getProvider(projectId, providerId);
  if (input.baseUrl !== undefined) await checkBaseUrl(existing.kind, input.baseUrl);
  const updated = await prisma.providerConfig
    .update({ where: { id: providerId }, data: { ...input, ...keyFields(apiKey) } })
    .catch(handleUnique);
  return toPublicProvider(updated);
}

export async function deleteProvider(projectId, providerId) {
  await getProvider(projectId, providerId);
  // Runs keep a reference to the provider they used, so a provider with run
  // history cannot be deleted (ON DELETE RESTRICT, Prisma error P2003).
  await prisma.providerConfig.delete({ where: { id: providerId } }).catch((err) => {
    if (err.code === 'P2003') throw conflict('This provider has runs. Delete those runs first.');
    throw err;
  });
}
