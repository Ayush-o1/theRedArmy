# Local setup

Everything needed to run theRedArmy, its worker and its tests on your machine. The shorter version is in the [README](../README.md#quick-start).

## Prerequisites

| Tool       | Version                                       | Used for                                                      |
| ---------- | --------------------------------------------- | ------------------------------------------------------------- |
| Node.js    | 22.9 or newer (developed and CI-tested on 24) | API, worker, scripts, tests                                   |
| npm        | the version bundled with Node                 | dependencies and scripts                                      |
| PostgreSQL | tested with 17 (Docker, CI) and 18 (local)    | all data and the job queue                                    |
| Redis      | tested with 7.4                               | shared rate limits                                            |
| Docker     | any recent version with Compose v2            | optional, but the simplest way to run PostgreSQL and Redis    |
| OpenSSL    | any                                           | generating `ENCRYPTION_KEY` (preinstalled on macOS and Linux) |

No LLM API key is needed: the built-in simulated provider works offline.

## 1. Install

```bash
git clone https://github.com/Ayush-o1/theRedArmy.git
cd theRedArmy
npm install
```

`npm install` also runs `prisma generate` (the `postinstall` script), which builds the database client.

## 2. Start PostgreSQL and Redis

**With Docker** (recommended):

```bash
docker compose up -d redis postgres
```

This starts Redis on `6379`, and PostgreSQL on **`5433`** (not 5432, so it does not clash with a local install) with user, password and database all `theredarmy`. Data lives in the `pgdata` volume.

**Without Docker:** run your own PostgreSQL and Redis, create a database, and use its URL as `DATABASE_URL` in the next step.

## 3. Configure

```bash
cp .env.example .env
sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak
```

The `sed -i.bak` form works with both macOS and GNU `sed`. Alternatively, paste the output of `openssl rand -base64 32` after `ENCRYPTION_KEY=` by hand.

The other values in `.env.example` already match the Docker services. Every variable is explained in [configuration.md](configuration.md).

## 4. Create the schema and (optionally) demo data

```bash
npm run db:deploy   # applies the migrations in prisma/migrations
npm run db:seed     # demo account, project, and two queued runs
```

The seed creates `aarav.mehta@theredarmy.test` / `theRedArmy-demo`, **for local use only**. It is safe to re-run: it replaces the demo account. Details: [README → Demo account](../README.md#demo-account).

`npm run db:migrate` is only for changing the schema: it creates a new migration from edits to `prisma/schema.prisma`.

## 5. Run the API and the worker

Use two terminals:

```bash
npm start          # API and UI on http://localhost:3000   (or: npm run dev, which restarts on changes)
npm run worker     # executes runs
```

The API never executes runs itself: without a worker, runs stay `QUEUED`. You can start several workers; they share the queue and the provider rate limits safely.

Logs are JSON lines. To read them comfortably: `npm start | npx pino-pretty`.

Check that both services are reachable:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

## 6. Run the tests

The tests need their own database and Redis database number, because **they truncate every table** and flush Redis.

```bash
cp .env.test.example .env.test
sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env.test && rm .env.test.bak
docker compose exec postgres createdb -U theredarmy theredarmy_test   # once

npm test             # migrates the test database, then unit + integration tests
npm run test:unit    # unit tests only (no services needed, but .env.test must exist)

npx playwright install chromium   # once per machine
npm run test:e2e     # browser tests; starts its own API and worker on port 3100

npm run lint
npm run format:check
```

What each suite covers: [testing.md](testing.md).

## 7. Everything in containers (optional)

```bash
export ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose --profile full up --build
```

This builds the image, runs a one-off `migrate` container, and then starts the API on port 3000 and one worker. Seed data is not loaded automatically.

## Troubleshooting

| Symptom                                                                  | Cause and fix                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid environment configuration:` and the process exits               | A required variable is missing or invalid; the message lists which. Usually `.env` (or `.env.test`) was not created, or `ENCRYPTION_KEY` is empty.                                                                                                                                                                                                   |
| Many tests fail with `MaxRetriesPerRequestError`                         | Redis is not running. Start it (`docker compose up -d redis`) and check with `docker compose exec redis redis-cli ping`. If Docker itself is stopped, start Docker Desktop first.                                                                                                                                                                    |
| `/api/health` returns `503` with `"redis":"down"` or `"database":"down"` | That service is not reachable at the URL in `.env`.                                                                                                                                                                                                                                                                                                  |
| `password authentication failed for user "theredarmy"`                   | Your Docker `pgdata` volume was created earlier with different credentials (for example before the project was renamed from PromptGate). PostgreSQL applies `POSTGRES_USER` only when a volume is first created. Either use the old credentials in `DATABASE_URL`, or recreate the volume with `docker compose down -v`, **which deletes its data**. |
| `database "theredarmy_test" does not exist` when running `npm test`      | Create it once: `docker compose exec postgres createdb -U theredarmy theredarmy_test`.                                                                                                                                                                                                                                                               |
| Runs stay `QUEUED` forever                                               | No worker is running. Start `npm run worker`.                                                                                                                                                                                                                                                                                                        |
| `npm run test:e2e` fails with "Executable doesn't exist"                 | The browser is not installed: `npx playwright install chromium`.                                                                                                                                                                                                                                                                                     |
| `npm run test:e2e` says port 3100 is already used                        | A previous test server is still running. Stop it, or stop whatever else uses port 3100.                                                                                                                                                                                                                                                              |
| An OpenAI-compatible provider pointing at `localhost` is rejected        | The SSRF guard blocks private addresses by default. For a local model server, set `ALLOW_PRIVATE_PROVIDER_URLS=true` in `.env` (never on a shared deployment).                                                                                                                                                                                       |
| Saved provider API keys fail to decrypt after a restart                  | `ENCRYPTION_KEY` changed. Restore the old key, or re-enter the provider keys.                                                                                                                                                                                                                                                                        |
| Login fails in production but works locally                              | With `NODE_ENV=production` the session cookie is `Secure` and is only sent over HTTPS.                                                                                                                                                                                                                                                               |

## Upgrading a setup from before the rename

The project was previously called PromptGate. Renaming the source does not change anything already on your machine:

- An existing `.env` or `.env.test` keeps its old `DATABASE_URL`. It still works; update it only if you want the new names.
- An existing Docker `pgdata` volume keeps its old credentials (see the troubleshooting row above).
- Issued API keys (`pgk_…`) and login sessions keep working. The key prefix and the session cookie name were intentionally not renamed.
