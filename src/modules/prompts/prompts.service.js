import { prisma } from '../../db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { listVariables } from '../../engine/template.js';

const withVariables = (version) => ({ ...version, variables: listVariables(version.template) });

export async function listPrompts(projectId) {
  const prompts = await prisma.prompt.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  return prompts.map(({ versions, ...p }) => ({
    ...p,
    latest: versions[0] ? withVariables(versions[0]) : null,
  }));
}

export async function getPrompt(projectId, promptId) {
  const prompt = await prisma.prompt.findFirst({
    where: { id: promptId, projectId },
    include: { versions: { orderBy: { version: 'desc' } } },
  });
  if (!prompt) throw notFound('Prompt');
  return { ...prompt, versions: prompt.versions.map(withVariables) };
}

/**
 * Creates the next version of a prompt.
 *
 * Version numbers come from an atomic counter on the prompt row. The UPDATE
 * takes a row lock, so two people saving at the same moment get versions N+1
 * and N+2, never the same number. Reading MAX(version) and adding one would
 * have a race window between the read and the insert.
 */
async function insertVersion(tx, promptId, version) {
  const { latestVersion } = await tx.prompt.update({
    where: { id: promptId },
    data: { latestVersion: { increment: 1 } },
    select: { latestVersion: true },
  });
  return tx.promptVersion.create({ data: { ...version, promptId, version: latestVersion } });
}

export async function createPrompt(projectId, { name, description, version }) {
  try {
    return await prisma.$transaction(async (tx) => {
      const prompt = await tx.prompt.create({ data: { projectId, name, description } });
      const first = await insertVersion(tx, prompt.id, version);
      return { ...prompt, latestVersion: 1, versions: [withVariables(first)] };
    });
  } catch (err) {
    if (err.code === 'P2002') throw conflict('A prompt with this name already exists in the project');
    throw err;
  }
}

export async function createVersion(projectId, promptId, version) {
  const prompt = await prisma.prompt.findFirst({ where: { id: promptId, projectId }, select: { id: true } });
  if (!prompt) throw notFound('Prompt');
  const created = await prisma.$transaction((tx) => insertVersion(tx, promptId, version));
  return withVariables(created);
}

export async function deletePrompt(projectId, promptId) {
  const prompt = await prisma.prompt.findFirst({ where: { id: promptId, projectId }, select: { id: true } });
  if (!prompt) throw notFound('Prompt');
  await prisma.prompt.delete({ where: { id: promptId } }).catch((err) => {
    if (err.code === 'P2003') throw conflict('This prompt has runs. Delete those runs first.');
    throw err;
  });
}
