import { redis } from '../redis.js';
import { tooManyRequests } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Fixed-window counter in Redis: INCR a key and give it a TTL on first use.
// Redis is used (not process memory) so limits hold across several API
// processes. It allows small bursts at window edges, which is acceptable for
// protecting login and the CI API.
export async function hitRateLimit(key, limit, windowSeconds) {
  const redisKey = `ratelimit:${key}`;
  const results = await redis
    .multi()
    .incr(redisKey)
    .expire(redisKey, windowSeconds, 'NX')
    .ttl(redisKey)
    .exec();
  const count = results[0][1];
  const ttl = results[2][1];
  return { allowed: count <= limit, retryAfterSeconds: Math.max(ttl, 1) };
}

export function rateLimit({ name, limit, windowSeconds, keyFn }) {
  return async (req, res, next) => {
    let outcome;
    try {
      outcome = await hitRateLimit(`${name}:${keyFn(req)}`, limit, windowSeconds);
    } catch (err) {
      // Fail open: if Redis is down we would rather serve requests than lock
      // every user out. Login still requires a valid password.
      logger.warn({ err: err.message, limiter: name }, 'rate limiter unavailable, allowing request');
      return next();
    }
    if (!outcome.allowed) return next(tooManyRequests(outcome.retryAfterSeconds));
    next();
  };
}
