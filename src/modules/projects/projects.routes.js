// /api/projects and everything nested under a project. Every nested router
// runs after loadOwnedProject, so the handlers can trust req.project.
import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validate.js';
import { loadOwnedProject } from '../../middleware/auth.js';
import { providersRouter } from '../providers/providers.routes.js';
import { promptsRouter } from '../prompts/prompts.routes.js';
import { suitesRouter } from '../suites/suites.routes.js';
import { runsRouter } from '../runs/runs.routes.js';
import { apiKeysRouter } from '../apiKeys/apiKeys.routes.js';
import * as service from './projects.service.js';

const fields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
};

export const projectsRouter = Router();

projectsRouter.get('/', async (req, res) => {
  res.json({ projects: await service.listProjects(req.user.id) });
});

projectsRouter.post('/', async (req, res) => {
  const input = parse(z.object(fields), req.body);
  res.status(201).json({ project: await service.createProject(req.user.id, input) });
});

projectsRouter.use('/:projectId', loadOwnedProject);

projectsRouter.get('/:projectId', (req, res) => {
  res.json({ project: req.project });
});

projectsRouter.patch('/:projectId', async (req, res) => {
  const input = parse(z.object(fields).partial(), req.body);
  res.json({ project: await service.updateProject(req.project.id, input) });
});

projectsRouter.delete('/:projectId', async (req, res) => {
  await service.deleteProject(req.project.id);
  res.status(204).end();
});

projectsRouter.use('/:projectId/providers', providersRouter);
projectsRouter.use('/:projectId/prompts', promptsRouter);
projectsRouter.use('/:projectId/suites', suitesRouter);
projectsRouter.use('/:projectId/runs', runsRouter);
projectsRouter.use('/:projectId/api-keys', apiKeysRouter);
