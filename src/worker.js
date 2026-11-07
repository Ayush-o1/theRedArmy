// Worker entry point: `npm run worker`. Run as many copies as you like; they
// coordinate through Postgres row locks and the shared Redis rate limiter.
import { config } from './config.js';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { Worker } from './engine/worker.js';

const worker = new Worker({
  concurrency: config.WORKER_CONCURRENCY,
  leaseSeconds: config.JOB_LEASE_SECONDS,
});
worker.start();

async function shutdown() {
  await worker.stop();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
