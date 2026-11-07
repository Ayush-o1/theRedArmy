# Repository audit

An assessment of how theRedArmy presents itself as a repository: documentation, setup, metadata and supporting files. It records the baseline before the polish work on branch `chore/theredarmy-repository-polish`, what was found, and what was changed. Application code was out of scope.

Audit date: 2026-11-07. Baseline commit: `444240b` (`main`, after PR #1).

## 1. Baseline

| Check                                     | Result                                    | Notes                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Working tree                              | Clean                                     | On `main`, in sync with `origin/main`                                                                                                                        |
| GitHub Actions on `main`                  | Passing                                   | Run for `444240b` concluded `success`                                                                                                                        |
| `npm run lint`                            | Pass                                      |                                                                                                                                                              |
| `npm run format:check`                    | Pass                                      |                                                                                                                                                              |
| `npm test` (unit + integration)           | 73/73 pass                                | First attempt: 44 failures with `MaxRetriesPerRequestError` because Docker Desktop (and therefore Redis) was not running. Environment issue, not a code one. |
| `npm run test:e2e`                        | 2/2 pass                                  | Same precondition: needs Postgres and Redis                                                                                                                  |
| `docker compose config` (default, `full`) | Valid                                     |                                                                                                                                                              |
| Branch protection on `main`               | None                                      | CI does not block merges; it is advisory                                                                                                                     |
| GitHub About                              | Description set; no topics; no website    |                                                                                                                                                              |
| License                                   | Declared MIT in `package.json` and README | No `LICENSE` file, so GitHub reports no license                                                                                                              |
| Private vulnerability reporting           | Disabled                                  |                                                                                                                                                              |

## 2. Architecture summary (verified against the source)

- **Two processes, one codebase.** `src/server.js` serves the API and the static UI. `src/worker.js` executes runs. They share PostgreSQL and Redis and never call each other.
- **API:** Express 5. Middleware: helmet with a strict CSP, request ids and logging, JSON body limit, cookies, sessions, CSRF. Routes are in `src/modules/<resource>/` (routes plus a service). `/api/v1` is the API-key CI interface.
- **Database:** PostgreSQL through Prisma 7 and the `pg` driver adapter. 12 tables, one migration. `run_cases` is both the result table and the job queue.
- **Job lifecycle:** run creation inserts the run and one `run_cases` row per test case in one transaction. Workers claim rows with `FOR UPDATE SKIP LOCKED` and a lease, and then:
  - render the template
  - check the response cache
  - take a Redis token
  - call the provider
  - evaluate the assertions
  - write the result with a fencing condition
  - try to finalize the run

  A reaper returns expired leases to the queue.

- **Redis:** a per-provider token bucket (Lua script), plus fixed-window limits for signup, login and the CI API. The response cache is in Postgres, not Redis.
- **LLM integration:** two adapters behind one interface. `SIMULATED` echoes the prompt and can inject failures. `OPENAI_COMPATIBLE` calls `/chat/completions`, behind an SSRF guard.
- **CI gate:** `evaluateGate` in `src/modules/runs/compare.js`. With a baseline, only regressions fail.
- **Tests:** `node:test` unit and integration tests against real Postgres and Redis; Playwright end-to-end tests that start their own API and worker on port 3100.
- **Delivery:** one Dockerfile (non-root, production dependencies). Compose runs Redis and Postgres; the `full` profile adds migrate, API and worker. GitHub Actions runs everything on pushes to `main` and on pull requests.

No component was found that the documentation describes but the code lacks.

## 3. Strengths

- Documentation is substantive and specific to this code: architecture with sequence diagrams, database design, API reference, design decisions with trade-offs, testing, research with verified citations, and a learning guide.
- Claims are honest: limitations are listed, the simulated provider is described as an echo, and there are no invented metrics.
- Real screenshots from the running app, with current branding and demo data.
- CI runs lint, formatting, all three test levels against real services, and a dependency audit.
- Setup has been tested from a fresh clone.

## 4. Problems found

| #   | Priority | Finding                                                                                                                                                                                                                                                                                                                                        |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1       | **No `LICENSE` file.** The license is declared but has no text, so GitHub shows "No license" and the README has to apologise for it.                                                                                                                                                                                                           |
| 2   | P1       | **No security reporting route.** No `SECURITY.md`, and private vulnerability reporting is disabled.                                                                                                                                                                                                                                            |
| 3   | P1       | **Configuration is incompletely documented.** `NODE_ENV` and `SESSION_TTL_HOURS` are read by `src/config.js` but missing from the README table and `.env.example`. `NODE_ENV=production` also changes behaviour (secure cookies), which is not mentioned.                                                                                      |
| 4   | P1       | **Lease/timeout rule stated wrongly.** Docs say the provider timeout must be "at least 5 s" shorter than the lease; the code requires `PROVIDER_TIMEOUT_MS + 5000 < JOB_LEASE_SECONDS × 1000`, so exactly 5 s is rejected. (The startup error message uses the same imprecise wording; left unchanged because this pass does not modify code.) |
| 5   | P1       | **Test setup needs a hand-written `.env.test`** whose contents exist only as a block in `TESTING.md`. There is no `.env.test.example`.                                                                                                                                                                                                         |
| 6   | P1       | **`TESTING.md` says unit tests need "nothing external".** They need no services, but they do need `DATABASE_URL` and `ENCRYPTION_KEY` set, because importing `config.js` validates the environment. Verified both ways.                                                                                                                        |
| 7   | P1       | **No troubleshooting.** The most likely failure (Redis not running → `MaxRetriesPerRequestError`, happened during this audit) and the Docker-volume credential mismatch after the rename are not explained where people will look.                                                                                                             |
| 8   | P1       | **No GitHub topics**, so the repository is not discoverable by technology or subject.                                                                                                                                                                                                                                                          |
| 9   | P2       | **README is long (262 lines)** and mixes overview with operator detail (full env table, upgrade notes). The overview should be quick to scan, with detail in dedicated docs.                                                                                                                                                                   |
| 10  | P2       | **No setup guide or CI guide.** Setup lives only in the README; the CI workflow is described in one line.                                                                                                                                                                                                                                      |
| 11  | P2       | **Inconsistent doc file naming:** existing docs are `UPPERCASE.md`, while the requested audit file and the owner's other repository use lowercase.                                                                                                                                                                                             |
| 12  | P2       | **No contribution guide.** For a solo project it mainly documents the conventions already in use (branches, commits, checks before a PR).                                                                                                                                                                                                      |
| 13  | P2       | **`test:db` script is undocumented.**                                                                                                                                                                                                                                                                                                          |
| 14  | P3       | **No custom social preview image.**                                                                                                                                                                                                                                                                                                            |

No secrets are tracked. `.gitignore` already covers env files, logs, Playwright output and editor folders. No duplicate, generated or orphaned files were found. All 63 internal links resolved.

## 5. Decisions

**Will change:**

- Add `LICENSE` (MIT, matching the existing declaration and the owner's other repository).
- Add `SECURITY.md` using GitHub private vulnerability reporting, with a fallback while that setting is off.
- Add `CONTRIBUTING.md` and `.env.test.example`.
- Add `docs/setup.md` (with troubleshooting), `docs/configuration.md` (every variable, from `src/config.js`) and `docs/ci-cd.md`.
- Rename the existing docs to lowercase with `git mv` so history is kept, and update every link.
- Fix the findings in rows 3–7 and 13.
- Shorten the README into an overview that links to the detailed guides.
- Add a license badge next to the CI badge (both point at real resources).
- Set GitHub topics.

**Will not do:**

- **No `CHANGELOG.md` yet.** There are no tagged releases, so it would contain only an "Unreleased" section duplicating git history. Start one with the first tagged release (Keep a Changelog format, SemVer tags).
- **No issue or PR templates.** For a solo project they add process without benefit.
- **No website** in the About section, because there is no public deployment.
- **No Node version, coverage or test-count badges.** Coverage is not measured, and a hand-maintained count would go stale.
- **No separate job-processing or decisions folder.** `architecture.md` and `decisions.md` already cover these well; splitting them would duplicate content.
- **No code changes**, including the imprecise startup error message noted in row 4.

## 6. GitHub metadata

**Description** (already set, kept): _Self-hosted LLM prompt regression testing with background workers, PostgreSQL job queues, Redis rate limiting, and CI regression gates._

**Topics** (12): `llm`, `prompt-engineering`, `prompt-testing`, `regression-testing`, `llm-evaluation`, `nodejs`, `express`, `postgresql`, `prisma`, `redis`, `job-queue`, `github-actions`.

Rationale:

- Subject topics (`llm`, `prompt-engineering`, `regression-testing`, `llm-evaluation`, `prompt-testing`) describe what the project is.
- Technology topics are limited to the core stack.
- `docker`, `background-jobs` and `developer-tools` were left out as either too broad or near-duplicates of `job-queue`.

**Social preview:** if wanted, a 1280×640 crop of the real run-detail screenshot (top bar, gate banner and a failed check) shows what the tool does better than a banner would. It can only be uploaded in **Settings → General → Social preview**; it cannot be set through the API.

## 7. Risks and precautions

- **Renaming docs** breaks external deep links to the old paths. There are none known (the repository is new); all internal links are updated and re-checked.
- **Documentation-only branch**, but the full test suite, lint, format check and Compose validation are rerun before the PR.
- **Every command in the new guides** is checked against `package.json`, and the setup path is run from a fresh clone.

## 8. Explicitly unchanged

Application code, database schema and migrations, API routes and payloads, environment variable names, UI design, screenshots (still accurate for the current UI and demo data), the CI workflow, Docker configuration, the `pgk_` key prefix and `pg_session` cookie.

## 9. Implementation phases

1. Add this audit.
2. Documentation: rename docs, add setup, configuration and CI guides, fix the inaccuracies above.
3. README: restructure as an overview, with badges, security and contributing sections.
4. Supporting files: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `.env.test.example`, `.env.example` completeness.
5. GitHub metadata: topics.
6. Verification (tests, lint, format, Compose, links, fresh-clone setup), then a pull request against `main`.
