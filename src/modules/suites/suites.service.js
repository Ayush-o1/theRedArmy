import { prisma } from '../../db.js';
import { conflict, notFound } from '../../lib/errors.js';

function uniqueViolation(message) {
  return (err) => {
    if (err.code === 'P2002') throw conflict(message);
    throw err;
  };
}

async function findSuite(projectId, suiteId) {
  const suite = await prisma.suite.findFirst({ where: { id: suiteId, projectId } });
  if (!suite) throw notFound('Suite');
  return suite;
}

export async function listSuites(projectId) {
  const suites = await prisma.suite.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { cases: true } } },
  });
  return suites.map(({ _count, ...s }) => ({ ...s, caseCount: _count.cases }));
}

export async function getSuite(projectId, suiteId) {
  const suite = await prisma.suite.findFirst({
    where: { id: suiteId, projectId },
    include: { cases: { orderBy: { createdAt: 'asc' } } },
  });
  if (!suite) throw notFound('Suite');
  return suite;
}

export async function createSuite(projectId, { cases = [], ...data }) {
  return prisma.suite
    .create({
      data: { ...data, projectId, cases: { create: cases } },
      include: { cases: true },
    })
    .catch(uniqueViolation('A suite with this name already exists, or two cases share a name'));
}

export async function updateSuite(projectId, suiteId, data) {
  await findSuite(projectId, suiteId);
  return prisma.suite
    .update({ where: { id: suiteId }, data })
    .catch(uniqueViolation('A suite with this name already exists'));
}

export async function deleteSuite(projectId, suiteId) {
  await findSuite(projectId, suiteId);
  await prisma.suite.delete({ where: { id: suiteId } }).catch((err) => {
    if (err.code === 'P2003') throw conflict('This suite has runs. Delete those runs first.');
    throw err;
  });
}

export async function addCases(projectId, suiteId, cases) {
  await findSuite(projectId, suiteId);
  // One transaction, so a bulk import is all-or-nothing.
  return prisma
    .$transaction(cases.map((c) => prisma.testCase.create({ data: { ...c, suiteId } })))
    .catch(uniqueViolation('A test case with this name already exists in the suite'));
}

async function findCase(projectId, suiteId, caseId) {
  const testCase = await prisma.testCase.findFirst({
    where: { id: caseId, suiteId, suite: { projectId } },
  });
  if (!testCase) throw notFound('Test case');
  return testCase;
}

// Editing a case does not change past runs: each run stored a snapshot of the
// case's variables and assertions when it was created.
export async function updateCase(projectId, suiteId, caseId, data) {
  await findCase(projectId, suiteId, caseId);
  return prisma.testCase
    .update({ where: { id: caseId }, data })
    .catch(uniqueViolation('A test case with this name already exists in the suite'));
}

export async function deleteCase(projectId, suiteId, caseId) {
  await findCase(projectId, suiteId, caseId);
  await prisma.testCase.delete({ where: { id: caseId } });
}
