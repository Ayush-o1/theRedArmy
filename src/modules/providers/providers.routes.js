import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validate.js';
import { requireUuidParams } from '../../lib/params.js';
import * as service from './providers.service.js';

const simulatorSettings = z
  .object({
    latencyMs: z.number().int().min(0).max(10_000).optional(),
    mode: z.enum(['echo', 'json']).optional(),
    rateLimitRate: z.number().min(0).max(1).optional(),
    errorRate: z.number().min(0).max(1).optional(),
    failUntilAttempt: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const base = {
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().url().max(500).nullish(),
  apiKey: z.string().max(500).nullish(),
  requestsPerMinute: z.number().int().min(1).max(10_000),
  inputCostPerMTok: z.number().min(0).max(1000),
  outputCostPerMTok: z.number().min(0).max(1000),
  settings: simulatorSettings,
};

const createSchema = z.object({
  ...base,
  kind: z.enum(['SIMULATED', 'OPENAI_COMPATIBLE']),
  requestsPerMinute: base.requestsPerMinute.default(60),
  inputCostPerMTok: base.inputCostPerMTok.default(0),
  outputCostPerMTok: base.outputCostPerMTok.default(0),
  settings: simulatorSettings.default({}),
});

// The kind is fixed after creation: switching a provider's kind would make
// past runs that reference it misleading.
const updateSchema = z.object(base).partial();

export const providersRouter = Router({ mergeParams: true });
requireUuidParams(providersRouter, 'providerId');

providersRouter.get('/', async (req, res) => {
  res.json({ providers: await service.listProviders(req.project.id) });
});

providersRouter.post('/', async (req, res) => {
  const input = parse(createSchema, req.body);
  res.status(201).json({ provider: await service.createProvider(req.project.id, input) });
});

providersRouter.patch('/:providerId', async (req, res) => {
  const input = parse(updateSchema, req.body);
  res.json({ provider: await service.updateProvider(req.project.id, req.params.providerId, input) });
});

providersRouter.delete('/:providerId', async (req, res) => {
  await service.deleteProvider(req.project.id, req.params.providerId);
  res.status(204).end();
});
