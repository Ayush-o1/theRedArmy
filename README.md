# PromptGate

**Regression testing for LLM prompts.** Write test cases once, run every new prompt version against them in background workers, and see exactly which cases broke. A CI pipeline can call the API and fail the build when a prompt change causes a regression.

![CI](https://github.com/Ayush-o1/theRedArmy/actions/workflows/ci.yml/badge.svg)

---

## The problem

Teams that build on large language models change their prompts often: to fix a bug, cut token cost, or switch models. Each change can quietly break behaviour that used to work. Studies of developers building LLM products describe this directly:

- Engineers found that classic unit testing breaks down ("every test is a flaky test"), and at least one team stopped automated LLM testing because of its cost ([Parnin et al., _Building Your Own Product Copilot_, 2023](https://arxiv.org/abs/2312.14231)).
- Users of LLM regression tools struggled to spot which output differences were regressions and to track how prompt edits affected outputs ([_RETAIN_, arXiv 2409.03928, 2024](https://arxiv.org/abs/2409.03928)).

Good tools already exist for this (Promptfoo, Langfuse experiments, Braintrust, LangSmith). PromptGate does not claim to fill an empty market gap. It is a focused, self-hosted implementation of the core workflow, built to show how the backend parts work: background jobs, retries, rate limits, caching, idempotency and crash recovery. See [docs/RESEARCH.md](docs/RESEARCH.md) for how the problem was chosen.

## What it does

| Feature                       | Details                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Immutable prompt versions** | Saving a prompt creates v1, v2, v3… Past runs always point at the exact text they used.                                                                      |
| **Test suites**               | Each case has template variables and deterministic checks (`contains`, `regex`, `is_json`, `json_field_equals`, length, latency…).                           |
| **Background execution**      | A run becomes one job per test case. Workers claim jobs from Postgres with `FOR UPDATE SKIP LOCKED`, so many workers can share the load safely.              |
| **Failure handling**          | Transient errors (429, 5xx, timeouts) are retried with exponential backoff and jitter, honouring `Retry-After`. Permanent errors (401, 400) are not retried. |
| **Crash recovery**            | Jobs are leased. If a worker dies, its jobs are reclaimed. A late write from a dead worker is rejected (fencing).                                            |
| **Shared rate limiting**      | A Redis token bucket per provider, used atomically by all workers.                                                                                           |
| **Response cache**            | Re-running unchanged cases at temperature 0 costs nothing. The cache is exact-match and scoped per project.                                                  |
| **Run comparison**            | Case-by-case diff between two runs: regressed, fixed, still failing, added, removed.                                                                         |
| **CI gate**                   | `POST /api/v1/runs` with an API key and an `Idempotency-Key`. The run reports `gate: passed/failed`. With a baseline, only _regressions_ fail the gate.      |
| **Providers**                 | A built-in **simulated** provider (free, injects latency and failures) and any **OpenAI-compatible** API (OpenAI, Groq, OpenRouter, Ollama, LM Studio…).     |

> **About the simulated provider:** it echoes the prompt back instead of generating text. It exists to exercise the pipeline (queueing, retries, caching, comparison) without an API key. It cannot tell you whether a real prompt is _good_. For that, connect a real provider.

## Screens

The UI is a vanilla JavaScript single-page app with no build step: projects, prompts with version history, suites with a structured check editor, providers, runs with live progress, a comparison view, and API key management.

**A run that regressed against its baseline**, with the failing check explained:

![Run detail](docs/images/run-detail.png)

**Case-by-case comparison of two prompt versions:**

![Comparison](docs/images/compare.png)

**Starting a run and the run history:**

![Runs](docs/images/runs.png)

These screenshots use the seeded demo data and the simulated provider, which echoes the prompt back.

## Tech stack

| Part            | Choice                             | Why                                                                                                                   |
| --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| API             | Node.js 24, Express 5              | Familiar, small, and Express 5 forwards async errors to the error handler.                                            |
| Database        | PostgreSQL + Prisma 7              | Relational data with real constraints. Prisma for everyday queries; raw SQL for the queue, where row locking matters. |
| Queue           | Postgres table (`run_cases`)       | A run and its jobs are created in one transaction. No dual-write between a database and a separate queue.             |
| Shared counters | Redis                              | Rate limiting must be atomic and shared across processes. A Lua script does check-and-take in one step.               |
| Validation      | zod                                | One schema both validates input and documents its shape.                                                              |
| Frontend        | HTML, CSS, vanilla JS modules      | No framework needed for this UI; every DOM update is explicit.                                                        |
| Tests           | `node:test`, supertest, Playwright | Built-in runner for unit and integration tests; Playwright for real browser journeys.                                 |

Every choice is explained in [docs/DECISIONS.md](docs/DECISIONS.md).

## Quick start

**Requirements:** Node.js 22.9 or newer (developed and tested on Node 24), Docker (for Redis, and optionally Postgres).

```bash
git clone https://github.com/Ayush-o1/theRedArmy.git promptgate
cd promptgate
npm install

# Start Redis and Postgres in Docker (Postgres on port 5433)
docker compose up -d redis postgres

# Create your .env from the example and fill in a random encryption key
cp .env.example .env
sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak

npm run db:deploy      # apply migrations
npm run db:seed        # optional: demo account with a real regression

npm start              # API + UI on http://localhost:3000
npm run worker         # in a second terminal: executes runs
```

Open <http://localhost:3000>. If you ran the seed, log in as `demo@promptgate.local` / `promptgate-demo`. Two runs are queued: v1 passes and v2 regresses. Open the second run and choose **Compare with baseline**.

**Using your own Postgres instead of Docker?** Set `DATABASE_URL` in `.env` to point at it.

**Everything in containers:**

```bash
export ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose --profile full up --build
```

### Environment variables

| Variable                      | Required | Default                    | Purpose                                                                                                            |
| ----------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                | yes      | —                          | Postgres connection string                                                                                         |
| `ENCRYPTION_KEY`              | yes      | —                          | 32 random bytes, base64. Encrypts provider API keys. Changing it makes stored keys unreadable.                     |
| `REDIS_URL`                   | no       | `redis://localhost:6379/0` | Rate limiting                                                                                                      |
| `PORT`                        | no       | `3000`                     | API port                                                                                                           |
| `ALLOW_PRIVATE_PROVIDER_URLS` | no       | `false`                    | Allow provider URLs on localhost/private networks (needed for a local Ollama). Keep `false` on shared deployments. |
| `WORKER_CONCURRENCY`          | no       | `4`                        | Jobs one worker process runs at once                                                                               |
| `JOB_LEASE_SECONDS`           | no       | `60`                       | How long a worker may hold a job before it can be reclaimed                                                        |
| `PROVIDER_TIMEOUT_MS`         | no       | `30000`                    | Per-request timeout. Must be at least 5 s shorter than the lease.                                                  |
| `LOG_LEVEL`                   | no       | `info`                     | `silent` in tests. Pipe logs through `npx pino-pretty` to read them.                                               |

The app validates these at startup and exits with a clear message if one is wrong.

## Scripts

| Command                           | What it does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm start` / `npm run dev`       | API and UI (dev restarts on file changes)                               |
| `npm run worker`                  | Job worker. Run several for more throughput.                            |
| `npm test`                        | Unit and integration tests (needs Postgres and Redis; uses `.env.test`) |
| `npm run test:unit`               | Unit tests only                                                         |
| `npm run test:e2e`                | Playwright browser tests (starts its own API and worker on port 3100)   |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                       |
| `npm run db:migrate`              | Create a new migration after editing the schema                         |
| `npm run db:deploy`               | Apply migrations                                                        |
| `npm run db:seed`                 | Demo data                                                               |

Testing setup is described in [docs/TESTING.md](docs/TESTING.md).

## Using it from CI

```bash
# Start a run of the latest version of "ticket-reply", compared with the previous version
curl -X POST http://localhost:3000/api/v1/runs \
  -H "Authorization: Bearer $PROMPTGATE_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $GITHUB_SHA" \
  -d '{"prompt":"ticket-reply","suite":"core-tickets","provider":"simulator","baseline":"previous"}'

# Poll until run.gate.status is "passed" or "failed"
curl http://localhost:3000/api/v1/runs/<run id> -H "Authorization: Bearer $PROMPTGATE_KEY"
```

Full reference: [docs/API.md](docs/API.md).

## Project structure

```
src/
  server.js, worker.js      process entry points
  app.js                    Express app (middleware, routes)
  config.js                 validated environment variables
  engine/                   everything that executes runs
    queue.js                claim / complete / reschedule / reclaim jobs (SQL)
    processJob.js           one test case, end to end
    worker.js               poll loop, concurrency, lease reaper
    rateLimiter.js          Redis token bucket (Lua)
    responseCache.js        exact-match cache
    assertions.js           output checks
    backoff.js, template.js
    providers/              simulated, OpenAI-compatible, SSRF guard
  modules/                  HTTP routes + services per resource
  middleware/               auth, CSRF, rate limiting, errors, request ids
  lib/                      crypto, errors, validation helpers
public/                     the web UI (no build step)
prisma/                     schema and migrations
test/                       unit and integration tests
e2e/                        Playwright tests
docs/                       documentation
```

## Documentation

- [Research and problem selection](docs/RESEARCH.md)
- [Architecture](docs/ARCHITECTURE.md): components, request flows, the job queue
- [Database design](docs/DATABASE.md)
- [API reference](docs/API.md)
- [Design decisions and trade-offs](docs/DECISIONS.md)
- [Testing](docs/TESTING.md)
- [Learning guide](docs/LEARNING_GUIDE.md): understand the project from scratch and prepare for interviews

## Known limitations

These are real gaps, not planned features presented as done:

- **Checks are deterministic only.** There is no LLM-as-judge or semantic-similarity check, so free-form answers can only be tested with text, regex, JSON and length rules.
- **One owner per project.** No teams, roles or sharing.
- **Workers poll** Postgres every second when idle. Fine at this scale; `LISTEN/NOTIFY` would remove the delay.
- **SSRF guard has a DNS-rebinding gap.** The provider hostname is resolved for the check and again by `fetch`. See [DECISIONS.md](docs/DECISIONS.md).
- **Cost figures are estimates**, from token counts and the prices you enter.
- **Only OpenAI-compatible APIs** are supported for real models; there is no native Anthropic or Gemini adapter.
- **No password reset or email verification.**
- **Not production-hardened.** Basic security controls are in place and tested (see [ARCHITECTURE.md § Security](docs/ARCHITECTURE.md#security)), but there has been no external audit, load test or deployment behind a real proxy. Behind a reverse proxy you must configure Express `trust proxy` so rate limits see client IPs.

## License

MIT
