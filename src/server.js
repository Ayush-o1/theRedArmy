// HTTP entry point: `npm start`. The worker runs separately (`npm run worker`).
import { config } from './config.js';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { logger } from './lib/logger.js';

const server = createApp().listen(config.PORT, () => {
  logger.info({ port: config.PORT }, `PromptGate API listening on http://localhost:${config.PORT}`);
});

// Stop accepting connections, let in-flight requests finish, then close pools.
async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
