import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validate.js';
import { requireUuidParams } from '../../lib/params.js';
import * as service from './prompts.service.js';

const versionSchema = z.object({
  systemPrompt: z.string().max(20_000).default(''),
  template: z.string().min(1).max(50_000),
  temperature: z.number().min(0).max(2).default(0),
  maxTokens: z.number().int().min(1).max(32_000).default(512),
  note: z.string().trim().max(500).default(''),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  version: versionSchema,
});

export const promptsRouter = Router({ mergeParams: true });
requireUuidParams(promptsRouter, 'promptId');

promptsRouter.get('/', async (req, res) => {
  res.json({ prompts: await service.listPrompts(req.project.id) });
});

promptsRouter.post('/', async (req, res) => {
  const input = parse(createSchema, req.body);
  res.status(201).json({ prompt: await service.createPrompt(req.project.id, input) });
});

promptsRouter.get('/:promptId', async (req, res) => {
  res.json({ prompt: await service.getPrompt(req.project.id, req.params.promptId) });
});

// Versions are append-only. "Editing" a prompt means creating a new version,
// so every past run still points at the exact text it was run with.
promptsRouter.post('/:promptId/versions', async (req, res) => {
  const input = parse(versionSchema, req.body);
  res.status(201).json({ version: await service.createVersion(req.project.id, req.params.promptId, input) });
});

promptsRouter.delete('/:promptId', async (req, res) => {
  await service.deletePrompt(req.project.id, req.params.promptId);
  res.status(204).end();
});
