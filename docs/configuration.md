# Configuration

All configuration comes from environment variables. They are read and validated once at startup by [`src/config.js`](../src/config.js). If one is missing or invalid, the process prints every problem and exits:

```text
Invalid environment configuration:
  - ENCRYPTION_KEY: ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)
```

The API (`npm start`), the worker (`npm run worker`) and the seed script all use the same validation, so each of them needs the required variables, even the ones it does not use itself.

## Where values come from

| Command                                                         | Reads                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm start`, `npm run dev`, `npm run worker`, `npm run db:seed` | `.env` (if present), via Node's `--env-file-if-exists`                                                 |
| `npm run db:deploy`, `npm run db:migrate`                       | `.env`, via [`prisma.config.js`](../prisma.config.js)                                                  |
| `npm test`, `npm run test:unit`, `npm run test:db`              | `.env.test` (if present)                                                                               |
| `npm run test:e2e`                                              | `.env.test`, with `PORT=3100` set by [`playwright.config.js`](../playwright.config.js)                 |
| Docker Compose `full` profile                                   | Values written in [`docker-compose.yml`](../docker-compose.yml), plus `ENCRYPTION_KEY` from your shell |

**Variables already set in your shell take precedence over the file.** That is how CI and Docker supply their own values without an env file.

Templates: [`.env.example`](../.env.example) for development and [`.env.test.example`](../.env.test.example) for tests. Copy them to `.env` and `.env.test`. Both copies are ignored by Git.

## Reference

### Required

| Variable         | Format                                  | Example (safe to publish)                                                    | Purpose                                                                                                                                                                                                |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`   | PostgreSQL connection URL               | `postgresql://theredarmy:theredarmy@localhost:5433/theredarmy?schema=public` | Database for all data, including the job queue. The example matches the Postgres service in `docker-compose.yml`.                                                                                      |
| `ENCRYPTION_KEY` | 32 random bytes, base64 (44 characters) | generate with `openssl rand -base64 32`                                      | AES-256-GCM key for provider API keys stored in the database. **If it changes, stored provider keys can no longer be decrypted** and must be re-entered. Never reuse the same key across environments. |

### Optional

| Variable                      | Format                                                         | Default                    | Purpose                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | `development`, `test` or `production`                          | `development`              | In `production` the session cookie is marked `Secure`, so login only works over HTTPS. Nothing else changes.                                                                                                                                                              |
| `PORT`                        | positive integer                                               | `3000`                     | API and UI port.                                                                                                                                                                                                                                                          |
| `REDIS_URL`                   | Redis URL, optionally with a database number                   | `redis://localhost:6379/0` | Token bucket for provider rate limits, and the login, signup and CI-API rate limits. Use a different database number (the `/1` at the end) for tests.                                                                                                                     |
| `ALLOW_PRIVATE_PROVIDER_URLS` | `true` or `false`                                              | `false`                    | Allow OpenAI-compatible provider URLs that resolve to private, loopback or link-local addresses. Needed for a model server on your machine (Ollama, LM Studio) and for the integration tests. Keep `false` anywhere others can save providers: it is the SSRF protection. |
| `LOG_LEVEL`                   | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` | `info`                     | pino log level. Logs are JSON; pipe them through `npx pino-pretty` to read them.                                                                                                                                                                                          |
| `SESSION_TTL_HOURS`           | positive integer                                               | `168` (7 days)             | How long a login session lasts.                                                                                                                                                                                                                                           |
| `WORKER_CONCURRENCY`          | integer 1–64                                                   | `4`                        | Jobs one worker process runs at the same time. Run more worker processes for more throughput; the shared rate limit still applies.                                                                                                                                        |
| `JOB_LEASE_SECONDS`           | integer ≥ 5                                                    | `60`                       | How long a worker may hold a job before the reaper may give it to another worker.                                                                                                                                                                                         |
| `PROVIDER_TIMEOUT_MS`         | integer ≥ 1000                                                 | `30000`                    | Timeout for each provider request.                                                                                                                                                                                                                                        |

### Rule between the last two

`PROVIDER_TIMEOUT_MS + 5000` must be **less than** `JOB_LEASE_SECONDS × 1000`, so a provider call always ends more than 5 seconds before its lease expires. Otherwise a slow but healthy call could have its job reclaimed and run a second time. With the defaults, 30 000 + 5 000 < 60 000.

For example, `JOB_LEASE_SECONDS=60` with `PROVIDER_TIMEOUT_MS=55000` is rejected (exactly 5 s apart), and `PROVIDER_TIMEOUT_MS=54000` is accepted.

## Not configured by environment

These are fixed in code; change the code if you need different values:

| Setting                       | Value                                       | Where                                   |
| ----------------------------- | ------------------------------------------- | --------------------------------------- |
| Login rate limit              | 10 attempts per 15 minutes per IP and email | `src/modules/auth/auth.routes.js`       |
| Signup rate limit             | 20 per hour per IP                          | `src/modules/auth/auth.routes.js`       |
| CI API rate limit             | 120 requests per minute per API key         | `src/modules/ci/ci.routes.js`           |
| Retries                       | up to 4 attempts per test case              | `prisma/schema.prisma` (`max_attempts`) |
| Backoff                       | full jitter, 1 s base, 60 s cap             | `src/engine/backoff.js`                 |
| Worker poll interval / reaper | 1 s / 15 s                                  | `src/engine/worker.js`                  |
| Request body limit            | 1 MB                                        | `src/app.js`                            |

Per-provider settings (requests per minute, prices, simulator behaviour) are stored in the database and edited in the UI or through the API.

## Behind a reverse proxy

Express is not configured with `trust proxy`, so behind a proxy every request appears to come from the proxy's address and all users share one rate-limit counter. Setting `app.set('trust proxy', …)` in `src/app.js` to match your proxy is required before such a deployment. There is no environment variable for it yet.
