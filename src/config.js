// Reads and validates environment variables once at startup.
// Failing fast on a missing ENCRYPTION_KEY is much better than discovering it
// the first time someone saves a provider API key.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379/0'),
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)',
  }),
  // Real providers are called from the worker, so a user-supplied base URL is a
  // server-side request. Private/loopback targets are refused unless this is
  // explicitly enabled (needed for a local model server such as Ollama).
  ALLOW_PRIVATE_PROVIDER_URLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 7),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  // How long a worker may hold a job before another worker may reclaim it.
  JOB_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
});

const parsed = schema
  // If a provider call could outlive the job lease, the reaper would hand the
  // job to a second worker while the first is still waiting for a response.
  .refine((env) => env.PROVIDER_TIMEOUT_MS + 5000 < env.JOB_LEASE_SECONDS * 1000, {
    path: ['JOB_LEASE_SECONDS'],
    message: 'JOB_LEASE_SECONDS must exceed PROVIDER_TIMEOUT_MS by at least 5 seconds',
  })
  .safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});
