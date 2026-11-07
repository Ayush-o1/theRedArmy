import { isUuid } from '../middleware/auth.js';
import { notFound } from './errors.js';

// Rejects malformed ids in the URL with 404 before they reach Postgres, which
// would otherwise raise an "invalid uuid" error (a 500).
export function requireUuidParams(router, ...names) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => (isUuid(value) ? next() : next(notFound())));
  }
}
