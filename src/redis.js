import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './lib/logger.js';

export const redis = new Redis(config.REDIS_URL, {
  // Fail commands quickly instead of queueing them forever while Redis is down.
  maxRetriesPerRequest: 2,
  lazyConnect: false,
});

redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
