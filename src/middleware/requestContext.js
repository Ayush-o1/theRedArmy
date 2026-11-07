import crypto from 'node:crypto';
import { logger } from '../lib/logger.js';

// Gives every request an id (reusing a caller-supplied X-Request-Id if it looks
// sane), attaches a child logger, and logs one line when the response finishes.
export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.set('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    req.log.info(
      { method: req.method, path: req.originalUrl, status: res.statusCode, durationMs },
      'request',
    );
  });
  next();
}
