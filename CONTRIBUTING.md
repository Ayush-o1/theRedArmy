# Contributing

## Setup

Follow [docs/setup.md](docs/setup.md). For the tests you also need a separate test database:

```bash
cp .env.test.example .env.test     # set ENCRYPTION_KEY; DATABASE_URL points at theredarmy_test
docker compose exec postgres createdb -U theredarmy theredarmy_test
npx playwright install chromium    # once, for the browser tests
```

> The test suite truncates every table in the database named by `.env.test` and flushes its Redis database. Never point it at data you care about.

## Before opening a pull request

Run the same checks as CI:

```bash
npm run lint
npm run format:check      # or `npm run format` to fix
npm test                  # unit + integration
npm run test:e2e          # browser tests
```

What each suite covers, and how to run one file or one test: [docs/testing.md](docs/testing.md). The CI workflow is described in [docs/ci-cd.md](docs/ci-cd.md).

## Workflow

- Branch from `main` with a short descriptive name, for example `fix/cache-key-temperature` or `docs/setup-guide`. Do not commit directly to `main`.
- One concern per pull request.
- Write commit messages as an imperative summary line ("Add …", "Fix …"), optionally with a type prefix (`fix:`, `docs:`, `chore:`), followed by a body that explains why when it is not obvious.
- In the pull request, describe what changed and why, how you verified it, and anything you could not verify.

## Conventions

- **Plain JavaScript with ES modules.** No TypeScript, no frontend framework, no build step.
- **Keep the layers.** `*.routes.js` validates input with zod and shapes the HTTP response; `*.service.js` holds data access and rules. (The small API-key and CI routers query the database directly. Move logic into a service if they grow.) `src/engine/` knows nothing about HTTP.
- **Scope every query to the tenant.** Resources are looked up within `req.project` (or the owner's projects), and anything outside it returns 404.
- **Writes that must happen together go in one transaction.**
- **Concurrency is enforced by the database**: unique constraints, row locks and conditional updates, not "check then write" in application code.
- **Raw SQL only through tagged templates** (``prisma.$queryRaw`…` ``), never by concatenating strings.
- **No `innerHTML` in `public/`.** Build elements with `h()` so text stays text.
- **Comments explain why**: the rule, race or security reason behind code that would otherwise look odd.
- **Add a dependency only with a clear need.**
- **A behaviour change needs a test that fails without it.** Concurrency and failure behaviour is tested against real PostgreSQL and Redis, not mocks.

## Changing the database

1. Edit `prisma/schema.prisma`.
2. Run `npm run db:migrate` to create and apply a migration. Review the generated SQL.
3. Never edit a migration that has been applied; add a new one.
4. Commit the schema and the migration together, and update [docs/database.md](docs/database.md) if the design changed.

## Documentation

Keep docs in step with the code in the same pull request. In particular, update [docs/configuration.md](docs/configuration.md) and `.env.example` when you add an environment variable, and [docs/api.md](docs/api.md) when you change an endpoint.

## Security issues

Do not open a public issue; see [SECURITY.md](SECURITY.md).
