// Builds the Express application. Kept separate from server.js so tests can
// create the app without opening a network port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { loadSession, requireCsrf, requireUser } from './middleware/auth.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { ciRouter } from './modules/ci/ci.routes.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Strict CSP: the frontend loads only its own scripts and styles, with no
  // inline <script>. Even if some output were rendered unsafely, injected
  // scripts would not run.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(requestContext);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (req, res) => {
    const checks = { database: 'ok', redis: 'ok' };
    await prisma.$queryRaw`SELECT 1`.catch(() => (checks.database = 'down'));
    await redis.ping().catch(() => (checks.redis = 'down'));
    const healthy = Object.values(checks).every((v) => v === 'ok');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  });

  // Machine API for CI pipelines (API key auth, no cookies, no CSRF).
  app.use('/api/v1', ciRouter);

  // Browser API (session cookie + CSRF token).
  app.use('/api/auth', loadSession, authRouter);
  app.use('/api/projects', loadSession, requireUser, requireCsrf, projectsRouter);
  app.use('/api', notFoundHandler);

  app.use(express.static(publicDir, { index: 'index.html' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
