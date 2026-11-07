import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validate.js';
import { requireUuidParams } from '../../lib/params.js';
import { assertionListSchema } from '../../engine/assertions.js';
import * as service from './suites.service.js';

// Template variables are plain values; nested objects are allowed and are
// rendered into the prompt as JSON.
const caseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  variables: z.record(z.string().regex(/^[a-zA-Z_]\w*$/, 'Invalid variable name'), z.unknown()).default({}),
  assertions: assertionListSchema.default([]),
});

const suiteFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
};

const createSuiteSchema = z.object({ ...suiteFields, cases: z.array(caseSchema).max(500).default([]) });
const updateSuiteSchema = z.object(suiteFields).partial();
const addCasesSchema = z.object({ cases: z.array(caseSchema).min(1).max(500) });

export const suitesRouter = Router({ mergeParams: true });
requireUuidParams(suitesRouter, 'suiteId', 'caseId');

suitesRouter.get('/', async (req, res) => {
  res.json({ suites: await service.listSuites(req.project.id) });
});

suitesRouter.post('/', async (req, res) => {
  const input = parse(createSuiteSchema, req.body);
  res.status(201).json({ suite: await service.createSuite(req.project.id, input) });
});

suitesRouter.get('/:suiteId', async (req, res) => {
  res.json({ suite: await service.getSuite(req.project.id, req.params.suiteId) });
});

suitesRouter.patch('/:suiteId', async (req, res) => {
  const input = parse(updateSuiteSchema, req.body);
  res.json({ suite: await service.updateSuite(req.project.id, req.params.suiteId, input) });
});

suitesRouter.delete('/:suiteId', async (req, res) => {
  await service.deleteSuite(req.project.id, req.params.suiteId);
  res.status(204).end();
});

// Accepts one or many cases, so the UI form and a JSON bulk import share an endpoint.
suitesRouter.post('/:suiteId/cases', async (req, res) => {
  const { cases } = parse(addCasesSchema, req.body);
  res.status(201).json({ cases: await service.addCases(req.project.id, req.params.suiteId, cases) });
});

suitesRouter.patch('/:suiteId/cases/:caseId', async (req, res) => {
  const input = parse(caseSchema.partial(), req.body);
  const { suiteId, caseId } = req.params;
  res.json({ case: await service.updateCase(req.project.id, suiteId, caseId, input) });
});

suitesRouter.delete('/:suiteId/cases/:caseId', async (req, res) => {
  const { suiteId, caseId } = req.params;
  await service.deleteCase(req.project.id, suiteId, caseId);
  res.status(204).end();
});
