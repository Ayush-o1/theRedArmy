import { prisma } from '../../db.js';
import { conflict } from '../../lib/errors.js';

export async function listProjects(ownerId) {
  const projects = await prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { prompts: true, suites: true, runs: true } },
      runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, createdAt: true } },
    },
  });
  return projects.map(({ runs, _count, ...p }) => ({ ...p, counts: _count, lastRun: runs[0] ?? null }));
}

export async function createProject(ownerId, { name, description }) {
  try {
    return await prisma.project.create({ data: { ownerId, name, description } });
  } catch (err) {
    if (err.code === 'P2002') throw conflict('You already have a project with this name');
    throw err;
  }
}

export async function updateProject(projectId, data) {
  try {
    return await prisma.project.update({ where: { id: projectId }, data });
  } catch (err) {
    if (err.code === 'P2002') throw conflict('You already have a project with this name');
    throw err;
  }
}

// Deleting a project removes everything in it. Run history references prompt
// versions with ON DELETE RESTRICT, so delete runs first, in one transaction.
export async function deleteProject(projectId) {
  await prisma.$transaction([
    prisma.run.deleteMany({ where: { projectId } }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);
}
