// Project-scoped API keys for CI. Small enough that the data access lives here.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { parse } from '../../lib/validate.js';
import { notFound } from '../../lib/errors.js';
import { requireUuidParams } from '../../lib/params.js';

const publicKey = ({ keyHash: _keyHash, ...rest }) => rest;

export const apiKeysRouter = Router({ mergeParams: true });
requireUuidParams(apiKeysRouter, 'keyId');

apiKeysRouter.get('/', async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { projectId: req.project.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ apiKeys: keys.map(publicKey) });
});

apiKeysRouter.post('/', async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  // "pgk_" makes keys recognizable to secret scanners and in logs.
  const rawKey = `pgk_${randomToken(32)}`;
  const apiKey = await prisma.apiKey.create({
    data: { projectId: req.project.id, name, prefix: rawKey.slice(0, 10), keyHash: sha256(rawKey) },
  });
  // The only time the full key is ever returned.
  res.status(201).json({ apiKey: publicKey(apiKey), key: rawKey });
});

// Revoke instead of delete, so "last used" history is kept for auditing.
apiKeysRouter.delete('/:keyId', async (req, res) => {
  const { count } = await prisma.apiKey.updateMany({
    where: { id: req.params.keyId, projectId: req.project.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw notFound('API key');
  res.status(204).end();
});
