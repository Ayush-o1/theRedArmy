# Testing

## Strategy

| Level       | Tool                    | Runs against                | Purpose                                                                                            |
| ----------- | ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| Unit        | `node:test`             | Nothing external            | Pure logic: assertions, templates, backoff, comparison and gate rules, SSRF address checks, crypto |
| Integration | `node:test` + supertest | Real Postgres and Redis     | HTTP API, authorization, transactions, and the queue under concurrency and failure                 |
| End-to-end  | Playwright (Chromium)   | Real API + worker + browser | The main user journey, and XSS safety of rendered model output                                     |

**Why real Postgres and Redis instead of mocks?** The behaviour under test _is_ the database's behaviour: row locks, `SKIP LOCKED`, unique constraints rejecting a concurrent duplicate, and an atomic Lua script. A mock would test the mock.

**Why the simulated provider?** It makes failure paths deterministic. `failUntilAttempt: 1` means "fail the first attempt, succeed the second", so the retry test never flakes. Real HTTP behaviour (429 with `Retry-After`, 401, auth header, usage parsing) is tested against a small local HTTP server that mimics an OpenAI-compatible API.

## Running the tests

Prerequisites: Postgres and Redis running (`docker compose up -d redis postgres`, or local installs), and a `.env.test` file:

```bash
NODE_ENV=test
DATABASE_URL=postgresql://<user>@localhost:5432/promptgate_test?schema=public
REDIS_URL=redis://localhost:6379/1
ENCRYPTION_KEY=<openssl rand -base64 32>
ALLOW_PRIVATE_PROVIDER_URLS=true
LOG_LEVEL=silent
```

`ALLOW_PRIVATE_PROVIDER_URLS=true` is needed because the provider tests start a mock server on `127.0.0.1`. The SSRF guard itself is unit-tested with private URLs blocked. Create the test database once (`createdb promptgate_test`).

```bash
npm test            # applies migrations to the test DB, then unit + integration tests
npm run test:unit   # unit tests only
npm run test:e2e    # browser tests; starts API + worker on port 3100 against the test DB
npm run lint
npm run format:check
```

Integration tests truncate all tables (and flush Redis db 1) before each test. **Never point `.env.test` at a database you care about.** Tests run one file at a time (`--test-concurrency=1`) because they share the database.

In CI (GitHub Actions), Postgres and Redis run as service containers and all of the above runs on every push.

## What is covered

### Unit (`test/unit/`)

- Every assertion type, including case sensitivity, fenced JSON, typed JSON-field comparison, invalid regex rejected at validation time, and latency checks skipped for cache hits
- Template rendering; a missing variable is an error, not an empty string
- Backoff growth, cap, jitter bounds; `Retry-After` in seconds and HTTP-date forms
- Which HTTP statuses are retryable
- SSRF: private, loopback, link-local, IPv4-mapped IPv6; bad schemes; credentials in URLs
- Password hashing round-trip; encryption round-trip, random IV, tamper detection
- Run comparison categories and the gate rules (baseline vs no baseline, errors always fail)

### Integration (`test/integration/`)

**Auth and tenancy**

- Signup sets an httpOnly cookie, and only the session token's hash is stored
- Duplicate email → 409; all invalid fields reported at once
- Wrong password and unknown email produce identical responses
- Login rate limit → 429 with `Retry-After`
- Missing CSRF token → 403; logout invalidates the session server-side
- Another user's project and resources → 404; a run cannot reference another tenant's suite (and nothing is created)
- Malformed ids → 404, not 500

**Resources**

- Provider API keys are encrypted at rest, never returned, and removable
- 10 concurrent prompt saves get versions 2–11 exactly
- Invalid assertions rejected; duplicate case names → 409; bulk import is all-or-nothing
- Providers and suites used by runs cannot be deleted; deleting a project removes its runs

**Engine**

- A run executes every case and records pass/fail with reasons
- Editing a case after a run does not change that run
- Transient errors are retried then succeed; a case that never succeeds gives up after 4 attempts
- **Two workers on one 30-case run: every case runs exactly once**
- **A crashed worker's job is reclaimed and completed by another worker; the crashed worker's late write is rejected**
- A job whose worker dies on its final attempt is marked ERROR by the reaper, and the run still finishes
- **8 concurrent finalize calls: exactly one finalizes**
- Token bucket: burst of 6 at 60 rpm, then the 7th caller must wait; a locally rate-limited job is postponed without using an attempt
- Cache: second identical run is fully cached at $0; temperature > 0 is never cached; one tenant's cache never serves another
- Cancelling stops queued work; cancelling a finished run → 409
- Comparison finds regressions; gate fails with a reason
- Cursor pagination returns every run exactly once
- OpenAI-compatible adapter: 429 with `Retry-After` retried, decrypted key sent, token usage parsed; 401 not retried

**CI API**

- API key shown once, stored hashed
- Start by name, poll to a gate decision
- Same `Idempotency-Key` → same run; 5 concurrent identical requests → one run; same key with different body → 422
- `baseline: "previous"` picks the right run and the gate fails on regression
- Keys are project-scoped; revoked keys → 401

### End-to-end (`e2e/`)

1. Sign up → project → simulated provider → prompt → suite with a check → run v1 (gate passes) → save v2 that drops required text → run v2 against v1 → gate fails with "1 case(s) regressed" → case shows the failing check → comparison view shows the regression.
2. A test case whose output contains `<img onerror>` and `<script>` is displayed as text, and the script never executes.

## Known gaps

- No load or performance testing. No throughput numbers are claimed.
- The UI has two end-to-end journeys. Provider editing, API-key creation and bulk import through the UI were checked manually but have no automated browser test.
- No test against a real paid LLM API; the HTTP adapter is tested against a local mock that follows the OpenAI response format.
- Redis-down behaviour (fail open for login, fail closed for provider calls) is implemented but not covered by an automated test.
