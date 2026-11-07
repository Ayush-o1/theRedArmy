// Two ways to authenticate:
//  - Browser users: an httpOnly session cookie, plus a CSRF token header on
//    every state-changing request.
//  - CI pipelines: a project-scoped API key in the Authorization header.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

export const SESSION_COOKIE = 'pg_session';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Attaches req.user and req.session when a valid session cookie is present.
// Does not reject anonymous requests; requireUser does that.
export async function loadSession(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (session && session.expiresAt > new Date()) {
    req.session = session;
    req.user = session.user;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Synchronizer-token CSRF protection. The cookie is also SameSite=Lax, which
// already blocks most cross-site POSTs. The token is a second layer for
// browsers or setups where SameSite is not enforced.
export function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method) || !req.session) return next();
  const sent = req.get('x-csrf-token') ?? '';
  const expected = req.session.csrfToken;
  const ok =
    sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return next(forbidden('Missing or invalid CSRF token'));
  next();
}

// Loads :projectId and checks that the logged-in user owns it. A project that
// exists but belongs to someone else returns 404, not 403, so project ids
// cannot be probed.
export async function loadOwnedProject(req, res, next) {
  const { projectId } = req.params;
  if (!isUuid(projectId)) return next(notFound('Project'));
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: req.user.id } });
  if (!project) return next(notFound('Project'));
  req.project = project;
  next();
}

// CI authentication: "Authorization: Bearer pgk_...". Only the hash is stored,
// so the raw key is shown to the user exactly once, at creation time.
export async function requireApiKey(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, key] = header.split(' ');
  if (scheme !== 'Bearer' || !key?.startsWith('pgk_')) {
    return next(unauthorized('Missing or malformed API key'));
  }
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: sha256(key) },
    include: { project: true },
  });
  if (!apiKey || apiKey.revokedAt) return next(unauthorized('Invalid or revoked API key'));

  req.apiKey = apiKey;
  req.project = apiKey.project;
  // Bookkeeping only: never block the request on it.
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => req.log.warn({ err: err.message }, 'failed to update api key lastUsedAt'));
  next();
}
