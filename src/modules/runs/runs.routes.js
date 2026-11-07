import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validate.js';
import { requireUuidParams } from '../../lib/params.js';
import * as service from './runs.service.js';

export const createRunSchema = z.object({
  promptVersionId: z.uuid(),
  suiteId: z.uuid(),
  providerConfigId: z.uuid(),
  baselineRunId: z.uuid().nullish(),
  useCache: z.boolean().default(true),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
  promptId: z.uuid().optional(),
  suiteId: z.uuid().optional(),
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED']).optional(),
});

const compareSchema = z.object({ base: z.uuid(), head: z.uuid() });

export const runsRouter = Router({ mergeParams: true });
requireUuidParams(runsRouter, 'runId');

runsRouter.get('/', async (req, res) => {
  res.json(await service.listRuns(req.project.id, parse(listSchema, req.query)));
});

runsRouter.post('/', async (req, res) => {
  const input = parse(createRunSchema, req.body);
  const { run } = await service.createRun(req.project.id, input, { userId: req.user.id });
  // 202 Accepted: the run exists, but the work happens later in a worker.
  res.status(202).json({ run });
});

// Declared before /:runId so "compare" is not treated as a run id.
runsRouter.get('/compare', async (req, res) => {
  const { base, head } = parse(compareSchema, req.query);
  res.json(await service.compareRuns(req.project.id, base, head));
});

runsRouter.get('/:runId', async (req, res) => {
  res.json({ run: await service.getRun(req.project.id, req.params.runId) });
});

runsRouter.post('/:runId/cancel', async (req, res) => {
  res.json({ run: await service.cancelRun(req.project.id, req.params.runId) });
});

runsRouter.delete('/:runId', async (req, res) => {
  await service.deleteRun(req.project.id, req.params.runId);
  res.status(204).end();
});
