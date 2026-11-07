# Learning guide

This guide takes you from "what is this project?" to being able to discuss it for 30 minutes in a technical interview. Read it in order. Each part explains an idea simply first, then gives the correct terms and the code to read.

**Suggested plan:** one part per study session. After each part, close the guide and do the active-recall questions at the end without looking.

---

## A note on honesty before you start

This project was built with an AI coding assistant. In interviews, be accurate about that. A good way to say it:

> "I built theRedArmy with heavy use of an AI coding assistant. I chose the problem from research, reviewed the design decisions, and I've studied every part of the code, so I can walk you through how and why each piece works."

What you should be able to do, honestly, after studying this guide:

- Explain every design decision and its alternatives.
- Trace any request through the code.
- Change the code: add an assertion type, add an endpoint, write a test.

What you should **not** say: that you hand-wrote every line, or that it is used in production, or quote performance numbers. None were measured.

The best way to make the project truly yours is the exercises in Part 10: extend it yourself.

---

## Part 1: The project in two minutes

### Simple version

Companies use AI models like ChatGPT inside their products, for example to reply to support tickets. The instructions they give the model are called a **prompt**. People edit prompts all the time, and an edit that fixes one thing can silently break another.

theRedArmy is a testing tool for prompts. You write **test cases** ("for this ticket, the reply must mention the order number"). Every time you change the prompt, theRedArmy runs all the test cases against the new version and tells you which ones broke compared to before. A CI pipeline can call it and block a bad change.

**See it working before reading further.** Run `npm run db:seed`, start the API and the worker, and log in as `aarav.mehta@theredarmy.test` / `theRedArmy-demo`. The project is Monsoon Market, a fictional online store whose support team tests the prompt that drafts replies to tickets. Version 1 of the prompt quotes the customer's order number. Version 2 was shortened to save tokens and accidentally dropped it. Open the second run: 7 of 8 test cases regressed, and **Compare with baseline** shows the before and after side by side. Keep this example in mind; the rest of the guide explains how each step happens.

### Interview version

> "theRedArmy is a self-hosted regression-testing service for LLM prompts. Prompts are versioned immutably. A run executes one prompt version against a suite of test cases, each with input variables and deterministic checks. A run fans out into one job per test case. The jobs are executed by background workers that claim them from Postgres using `SKIP LOCKED`, with leases for crash recovery, exponential backoff for transient provider errors, a shared Redis token bucket for provider rate limits, and an exact-match response cache so unchanged cases cost nothing. Two runs can be compared case by case, and a CI endpoint with idempotency keys exposes a pass/fail gate where only regressions fail the build."

Practice saying the interview version out loud until you can do it without reading.

### Why this problem? (They will ask.)

Research found:

- Engineers building LLM products said classic unit testing does not fit ("every test is a flaky test") and that cost stopped automated testing (Parnin et al., arXiv 2312.14231).
- Another study found people struggle to tell real regressions apart from noise (RETAIN, arXiv 2409.03928).

Tools like Promptfoo and Langfuse exist. The point was not to beat them, but to build the core of such a system and get the hard backend parts right. Say that plainly; interviewers respect it.

---

## Part 2: The architecture

### Simple version

There are two programs and two databases:

1. **The API server** takes requests from the browser and from CI. When you start a run, it writes a to-do list into the database and replies immediately. It never talks to the AI model itself.
2. **The worker** reads the to-do list, calls the AI model for each item, checks the answer, and writes the result back. You can run several workers at once.
3. **PostgreSQL** stores everything, including the to-do list.
4. **Redis** stores small shared counters, like "how many requests have we sent to the AI provider this minute".

### Technical version

- **Modular monolith**: one codebase and two process types (`src/server.js`, `src/worker.js`). They coordinate through shared state, not direct calls.
- **Asynchronous processing**: `POST /runs` returns **202 Accepted**. The work happens later.
- **Layering**: `routes` (HTTP and validation) → `services` (data logic) → `engine` (execution, no HTTP knowledge).

Read: [architecture.md](architecture.md) (diagram at the top), then [`src/app.js`](../src/app.js) top to bottom.

**Why not just call the model inside the HTTP request?** A suite of 100 cases at 2 seconds each is over 3 minutes. HTTP requests would time out, a crash would lose all progress, and you could not use several machines. Background jobs fix all three.

---

## Part 3: Following one run through the code

Open these files side by side and trace the flow. This is the single most useful exercise in this guide.

### Step 1: The run is created

[`src/modules/runs/runs.routes.js`](../src/modules/runs/runs.routes.js) → `POST /` parses the body with zod, then calls `createRun` in [`runs.service.js`](../src/modules/runs/runs.service.js).

Inside `createRun`, in **one transaction**:

1. Check that the prompt version, suite, provider and baseline all belong to _this_ project. Without this check, a user could reference another customer's suite. That bug class is called **IDOR** (Insecure Direct Object Reference).
2. Insert the run and one `run_cases` row per test case, **copying** each case's variables and checks (a snapshot).

> **Why a transaction?** _Simple:_ either the run and all its to-do items are saved, or nothing is. _Technical:_ atomicity prevents a half-created run that would sit in `QUEUED` forever.

### Step 2: A worker claims jobs

[`src/engine/worker.js`](../src/engine/worker.js): every second (or immediately after finding work), `tick()` calls `claimJobs` in [`src/engine/queue.js`](../src/engine/queue.js).

```sql
WITH next AS (
  SELECT rc.id FROM run_cases rc JOIN runs r ON r.id = rc.run_id
  WHERE rc.status = 'PENDING' AND rc.available_at <= now() AND r.status IN ('QUEUED','RUNNING')
  ORDER BY rc.available_at LIMIT $limit
  FOR UPDATE OF rc SKIP LOCKED
)
UPDATE run_cases rc SET status = 'RUNNING', locked_by = $worker,
  lease_expires_at = now() + $lease * interval '1 second', attempts = rc.attempts + 1 ...
```

> **Simple:** each worker grabs a few free to-do items and puts its name on them. If another worker is grabbing at the same moment, it skips items that are being grabbed instead of waiting.
>
> **Technical:** `FOR UPDATE` row-locks the selected rows. `SKIP LOCKED` makes concurrent transactions skip already-locked rows instead of blocking, so N workers can poll the same table without double-claiming and without lock contention. The status change commits with the lock, so the claim is atomic.

### Step 3: The job is processed

[`src/engine/processJob.js`](../src/engine/processJob.js), in order:

1. Load the run, prompt version and provider.
2. If the run was cancelled meanwhile, mark the job `CANCELLED`.
3. Render the template ([`template.js`](../src/engine/template.js)). A missing `{{variable}}` → `ERROR`.
4. If cacheable (temperature 0 and the run allows it), look up the cache ([`responseCache.js`](../src/engine/responseCache.js)).
5. Otherwise, ask the **token bucket** for permission ([`rateLimiter.js`](../src/engine/rateLimiter.js)). If none is available, put the job back for later without counting an attempt.
6. Call the provider ([`providers/`](../src/engine/providers/)) with a timeout.
7. On a transient error, put the job back with a backoff delay. On a permanent error or no attempts left, mark it `ERROR`.
8. Check the output ([`assertions.js`](../src/engine/assertions.js)), then save PASSED/FAILED with tokens, cost and latency.
9. Try to finalize the run.

### Step 4: The run is finalized

`tryFinalizeRun` in [`queue.js`](../src/engine/queue.js) is one `UPDATE` that only succeeds when no job of the run is still pending or running. It computes all totals in the same statement. Many workers can call it at once; exactly one succeeds.

### Step 5: The user sees it

[`public/js/views/runDetail.js`](../public/js/views/runDetail.js) polls `GET /runs/:id` every 1.5 s while the run is active, then stops. The API computes `progress` live from `run_cases` and the `gate` with [`evaluateGate`](../src/modules/runs/compare.js).

---

## Part 4: Concurrency and failure, the heart of the interview

These are the questions that separate this project from a CRUD app. Know each one cold.

### 4.1 "What if two workers grab the same job?"

They cannot. `FOR UPDATE SKIP LOCKED` (Part 3, step 2). Proven by the test _two workers on the same run never process a case twice_ in [`test/integration/engine.test.js`](../test/integration/engine.test.js). It runs two workers in parallel on 30 cases and asserts every case has exactly one attempt.

### 4.2 "What if a worker crashes halfway through a job?"

- **Simple:** every claimed job has a deadline (the lease). Each worker regularly checks for jobs whose deadline passed and puts them back on the board.
- **Technical:** `reclaimExpiredLeases` resets `RUNNING` jobs with `lease_expires_at < now()` to `PENDING`. Attempts were counted at claim time, so a job that crashes every worker it touches eventually becomes `ERROR` instead of looping forever ("poison message" protection).

### 4.3 "What if the worker was just slow, not dead, and finishes after its job was given to someone else?"

This is the subtle one.

- **Simple:** when saving a result, the worker says "save this only if the job is still mine". If it is not, the save does nothing.
- **Technical:** this is called **fencing**. `completeJob` runs `UPDATE … WHERE id = $job AND locked_by = $me AND status = 'RUNNING'` and checks the affected row count. Test: _jobs held by a crashed worker are recovered, and its late result is discarded_.

Follow-up you might get: _"So can the provider be called twice for one job?"_ Yes. Delivery is **at-least-once**: if a worker got the answer but died before saving, the job runs again. The _result_ is recorded at most once thanks to fencing. That is acceptable because a test call has no external side effect; it costs one extra API call. If the job sent an email, you would need an idempotency key on the email itself.

### 4.4 "Why not just keep a database transaction open while calling the model?"

A transaction holds a database connection and its locks for the whole call, which could be 30 seconds. With 50 concurrent jobs, that is 50 idle connections, and long transactions block database maintenance (vacuum). A lease is just a timestamp. And `config.js` refuses to start unless the provider timeout is more than 5 s shorter than the lease, so a healthy call can never outlive its lease.

### 4.5 "Two workers finish the last two jobs at the same moment. Who marks the run complete?"

`tryFinalizeRun` is a conditional update: _set COMPLETED where the run is not finished AND no job is pending or running_.

- Each worker commits its own job result _before_ calling it.
- Whichever worker commits last is guaranteed to see both results, so the run is always finalized.
- The row lock taken by the `UPDATE` means a second caller re-checks the condition and does nothing.

Test: 8 concurrent calls → exactly one returns true.

### 4.6 "How do you respect a provider's rate limit across many workers?"

- **Simple:** a jar of tokens shared by everyone, refilled at a steady rate. You need a token to make a call. If the jar is empty, come back when one is ready.
- **Technical:** a **token bucket** in Redis. Capacity = 10% of the per-minute limit (allows small bursts), refilled continuously. "Refill, check, take" runs as a **Lua script**, which Redis executes atomically, so two workers cannot both take the last token. It uses Redis's clock (`TIME`), so worker clocks do not matter. An in-memory limiter would be wrong: three workers each allowing 60/min send 180/min.

### 4.7 "What happens on a 429 or 503?"

The job goes back to the queue with `available_at` set in the future. It does not sleep while holding a slot.

- The delay is **exponential backoff with full jitter**: random between 0 and 1 s, 2 s, 4 s… up to 60 s.
- If the provider sends `Retry-After`, that wins.
- **Jitter** prevents all failed jobs retrying at the same instant (thundering herd).
- Errors like 401 or 400 are **not** retried; they would fail the same way again.

Read [`backoff.js`](../src/engine/backoff.js) and `handleProviderError` in `processJob.js`.

### 4.8 "CI retried the request. Did you start two runs?"

No. **Idempotency keys**: the CI sends `Idempotency-Key: <commit sha>`. It is stored on the run with a **unique index** on `(project_id, idempotency_key)`.

- A repeat request finds the existing run and returns it.
- If two identical requests arrive simultaneously, both pass the "does it exist?" check, but the unique index lets only one insert succeed. The loser catches the unique-violation error and returns the winner's run. Test: 5 parallel requests → 1 run.
- A _different_ request body with the same key → `422`, which catches client bugs.

**Key lesson:** "check, then insert" is a race. The database constraint is what makes it correct.

### 4.9 "Two people save a new prompt version at once. Do they both get v5?"

No. `UPDATE prompts SET latest_version = latest_version + 1 RETURNING …` inside the insert's transaction. The row lock serializes concurrent saves, so they get v5 and v6. Test: 10 concurrent saves → versions 2–11.

---

## Part 5: The database

Read [database.md](database.md) and [`prisma/schema.prisma`](../prisma/schema.prisma).

Things to be able to explain:

- **Why `run_cases` is also the queue** (see Part 7, decision 1).
- **Snapshots:** runs copy test-case inputs so history is not rewritten when a case is edited.
- **`ON DELETE RESTRICT`** on run → prompt version/suite/provider. You cannot delete what history depends on, so the API returns 409.
- **Indexes:** `(status, available_at)` exists for the worker's polling query. Be ready for "what index would you add for X?"
- **Why aggregates are computed once** at finalization instead of incremented by each worker. Incrementing from many workers is possible (`SET passed = passed + 1` is atomic), but a recompute is correct by construction and is easier to verify.
- **Keyset pagination** (`cursor`) vs `OFFSET`. With `OFFSET 1000` the database still reads and discards 1000 rows, and new rows shift pages, causing duplicates or skips. A cursor ("rows after this id") avoids both.

---

## Part 6: Security

For each item, know _the attack_ and _the defence_. Details: [architecture.md § Security](architecture.md#security).

| Attack                                          | Defence                                                                                               | File                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| Database leak reveals passwords                 | scrypt (slow, salted, memory-hard)                                                                    | `src/lib/crypto.js`              |
| Database leak reveals sessions/API keys         | Store only SHA-256 hashes of tokens                                                                   | `src/middleware/auth.js`         |
| Guessing passwords                              | Rate limit 10 / 15 min per IP + email                                                                 | `auth.routes.js`                 |
| Finding which emails are registered             | Same message and similar timing for both failures (a dummy hash is checked when the email is unknown) | `auth.service.js`                |
| XSS stealing the session                        | httpOnly cookie, strict Content-Security-Policy, UI never uses `innerHTML`                            | `app.js`, `public/js/dom.js`     |
| CSRF (a malicious site makes your browser POST) | SameSite=Lax cookie + `X-CSRF-Token` header                                                           | `middleware/auth.js`             |
| IDOR (`/projects/<someone else's id>`)          | Every query is scoped to the owner; foreign resources return 404                                      | `loadOwnedProject`, services     |
| Provider API keys leaked from the DB            | AES-256-GCM encryption, never returned by the API                                                     | `lib/crypto.js`                  |
| SSRF (provider URL = `http://169.254.169.254`)  | Resolve the host, block private ranges, refuse redirects                                              | `engine/providers/urlGuard.js`   |
| SQL injection                                   | Prisma parameterises; raw SQL uses tagged templates (bind parameters)                                 | `engine/queue.js`                |
| Stored XSS through model output                 | Rendered as text; e2e test proves a `<script>` does not run                                           | `e2e/regression-journey.spec.js` |

**Why model output is untrusted:** a model can be manipulated (prompt injection) into producing HTML or script. Treat it like user input.

**Honest gap to mention unprompted, because it shows depth:** the SSRF check has a **DNS-rebinding** window. The hostname is resolved for the check and again by `fetch`. The fix is to connect to the IP that was checked.

---

## Part 7: Decisions you must be able to defend

Full list: [decisions.md](decisions.md). The top five:

1. **Postgres as the queue instead of Redis/BullMQ.** The dual-write problem: saving a run in Postgres and pushing jobs to Redis are two writes, and a crash between them corrupts state. One transaction avoids it. Trade-off: lower max throughput and polling, irrelevant when each job waits on an LLM.
2. **Sessions instead of JWT.** Instant revocation (delete the row), and an httpOnly cookie protects against XSS token theft. A JWT denylist would be a session table anyway.
3. **Exact-match cache instead of semantic cache.** A false cache hit in a _testing_ tool hides a regression. Temperature > 0 is never cached, because variance is the point.
4. **Deterministic checks instead of LLM-as-judge.** A judge is non-deterministic and costs money per case, which is the very problem being addressed. It is the top future feature.
5. **Vanilla JS instead of React.** The UI is forms and tables. No build step keeps the CSP strict, and DOM-node building makes XSS-safe rendering the default.

When asked "why X?", use this pattern: **what problem X solves → what the alternative was → what we gave up**.

---

## Part 8: Technologies, briefly

| Technology           | What it is                                                               | Role here                                                                                           |
| -------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Express 5**        | Minimal Node HTTP framework                                              | Routing and middleware. v5 forwards errors from `async` handlers automatically.                     |
| **Prisma 7**         | ORM: generates a typed client from a schema file, and manages migrations | All CRUD. Connects through the `pg` driver adapter (`@prisma/adapter-pg`), which Prisma 7 requires. |
| **PostgreSQL**       | Relational database                                                      | Data, constraints, row locks, the queue                                                             |
| **Redis**            | In-memory key-value store                                                | Atomic shared counters (token bucket, login limits)                                                 |
| **Lua in Redis**     | Scripts Redis runs atomically                                            | Read-modify-write without race conditions                                                           |
| **zod**              | Schema validation library                                                | Validates every request body and query, and the environment variables                               |
| **pino**             | Fast structured JSON logger                                              | Logs with request id and worker id; redacts secrets                                                 |
| **helmet**           | Sets security headers                                                    | Content-Security-Policy and friends                                                                 |
| **node:test**        | Node's built-in test runner                                              | Unit and integration tests, with no extra framework                                                 |
| **supertest**        | HTTP assertions against an Express app                                   | Integration tests without opening a port                                                            |
| **Playwright**       | Browser automation                                                       | End-to-end tests in real Chromium                                                                   |
| **Docker / Compose** | Containers                                                               | Redis and Postgres for development; full stack in one command                                       |
| **GitHub Actions**   | CI                                                                       | Lint, format, all tests with real services on every push to `main` and every pull request           |

---

## Part 9: Interview questions with natural answers

Do not memorise these word for word. Read the idea, then answer in your own words.

**Q: Walk me through what happens when I click "Start run".**
The browser posts the prompt version, suite and provider to the API. The API validates the input and, in one transaction, checks that everything belongs to my project, creates the run, and creates one job row per test case with a snapshot of its inputs. It returns 202 straight away. Workers polling the table claim jobs with `SKIP LOCKED`, call the model, check the output, and save results. The last job to finish triggers a conditional update that marks the run complete. The page polls every 1.5 seconds and shows progress.

**Q: Why use a queue at all?**
Calling the model takes seconds per case. Doing it inside the request would time out, lose progress on a crash, and could not scale out. A queue makes the work durable, retryable and parallel.

**Q: Why Postgres and not Redis for the queue?**
Atomicity with the run itself. The run and its jobs are created in one transaction, so there is no state where a run exists without jobs. With Redis I would need an outbox pattern for the same guarantee. The cost is throughput, which does not matter when each job waits on an LLM.

**Q: How do you make sure no job runs twice at the same time?**
`FOR UPDATE SKIP LOCKED` when claiming, and a test that runs two workers on the same run and checks every case was attempted exactly once.

**Q: What are your delivery semantics?**
At-least-once for the provider call, at-most-once for recording the result. A crash after the call but before the save means the call repeats. Fencing on `locked_by` means a stale worker cannot overwrite a newer result.

**Q: How did you test concurrency? Isn't that hard to test?**
The tests use the real database, so locks behave for real. They start two workers and claim in parallel. For crash recovery they simulate a dead worker by claiming a job and expiring its lease by hand, then check that another worker completes it and the dead worker's late write is rejected.

**Q: What happens if Redis goes down?**
Two behaviours, on purpose. The login rate limiter fails _open_: logins still work, they are just not throttled for a while. The provider rate limiter fails _closed_: jobs wait and retry, because calling a provider without the shared limit could exceed quota for everyone. Cached responses are in Postgres, so caching keeps working.

**Q: How does the cache key work, and what are its risks?**
It is a SHA-256 of everything that affects the output: project, provider, model, system prompt, rendered prompt, temperature, max tokens. The project is included so tenants never share entries. The risk is that a provider updating a model under the same name would not invalidate it; you can run with the cache off to re-check.

**Q: How would you scale this to 100× the load?**
Run more workers first; they scale horizontally. The Redis limiter keeps them within provider limits. Then:

- Replace polling with `LISTEN/NOTIFY` to cut idle queries.
- Use a connection pooler like PgBouncer as worker count grows.
- Partition or archive old `run_cases`.
- If job volume really outgrew Postgres, move to a dedicated queue with a transactional outbox.

I would measure before changing anything; I have not load-tested it.

**Q: What would you build next?**
LLM-as-judge assertions (with their own cost controls); teams and roles; `LISTEN/NOTIFY` instead of polling; closing the DNS-rebinding gap; a native Anthropic adapter.

**Q: What was the hardest bug or decision?**
Answer honestly from what you learned. Good candidates:

- **The fencing problem:** realising a lease alone is not enough when a worker is slow rather than dead.
- **The idempotency race:** why "check then insert" fails, and why the unique index is the real guarantee.
- **The CSP and inline styles bug:** the progress bar silently did not render because `style="…"` attributes are blocked by `style-src 'self'`. Setting `element.style` via JavaScript is allowed, so the `h()` helper takes a style object instead.

**Q: Why should a failing case that already failed before not fail the build?**
So teams can add a test for a known bug before fixing it, without blocking every merge. The gate fails only on _regressions_: cases that passed in the baseline and fail now. Errors always fail, because an unverified case is not a pass.

### Likely follow-ups to prepare

- What is the difference between `FOR UPDATE`, `FOR UPDATE NOWAIT` and `FOR UPDATE SKIP LOCKED`?
- What isolation level does Postgres use by default, and does it matter for `tryFinalizeRun`? (Read Committed; explain why the last committer always sees all results.)
- Why hash API keys with SHA-256 but passwords with scrypt? (API keys are 256 bits of randomness, so brute force is impossible and a fast hash is fine. Passwords are low-entropy, so you need a slow hash.)
- Why is the CSRF token needed if the cookie is SameSite=Lax?
- What is a thundering herd?
- How would you add a new assertion type? (Add it to the zod union and the `checks` object in `assertions.js`, plus a unit test.)

---

## Part 10: Active recall and exercises

### Recall: answer without looking

1. What HTTP status does starting a run return, and why that one?
2. Name the four fields on `run_cases` that implement the queue.
3. What two conditions must hold for `completeJob` to save a result?
4. Why is the provider timeout required to be shorter than the lease?
5. What does `SKIP LOCKED` do that plain `FOR UPDATE` does not?
6. Which errors are retried, and which are not? Why?
7. Why is Redis needed for rate limiting but not for caching?
8. What is in the cache key, and why is the project id included?
9. What makes idempotency correct under concurrent requests?
10. Why do run cases store a copy of the variables and checks?
11. What is the dual-write problem?
12. Name three defences against XSS in this project.
13. What is IDOR, and how does the API prevent it?
14. When does the CI gate fail?
15. What is the known gap in the SSRF protection?

### Exercises: do these to own the code

1. **Easy:** add a `starts_with` assertion. Touch `assertions.js` (schema and check), `public/js/views/suites.js` (editor) and add a unit test.
2. **Easy:** add an index you think the run list needs for filtering by status, write the migration (`npm run db:migrate`) and explain why.
3. **Medium:** add a "Retry errored cases" button that creates a new run containing only the cases that errored. Think about where the logic belongs (service, not route).
4. **Medium:** replace worker polling with Postgres `LISTEN/NOTIFY`: `NOTIFY` after creating a run, `LISTEN` in the worker, and keep polling as a fallback.
5. **Hard:** fix the DNS-rebinding gap by resolving the hostname once and connecting to that IP (look at the `lookup` option of an HTTP agent, or undici's `connect` options).
6. **Hard:** add an `llm_judge` assertion that calls a provider with a grading prompt. Decide how its cost and retries are handled, and whether its own response is cached.

After each exercise, run `npm test` and `npm run lint`. Being able to say "I added X, and here is the test" is the strongest thing you can bring to an interview.

---

## Part 11: Common mistakes and limitations to know

- Running `npm test` against your development database: the tests **truncate every table**. `.env.test` must point at a separate database.
- Forgetting to start the worker: runs stay `QUEUED` forever. The API never executes jobs itself.
- Changing `ENCRYPTION_KEY`: existing provider keys can no longer be decrypted.
- Behind a reverse proxy, Express sees the proxy's IP unless `trust proxy` is configured, so rate limits would apply to everyone at once.
- The simulated provider echoes the prompt. A demo with it shows the pipeline, not model quality.
- The project was renamed from PromptGate to theRedArmy. A local `.env` or Docker volume created before the rename keeps its old database names; the README explains how to update them. The `pgk_` API-key prefix and `pg_session` cookie name were kept on purpose, so existing keys and sessions still work.
- Limitations are listed honestly in the [README](../README.md#known-limitations). Mention them before the interviewer finds them.
