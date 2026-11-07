# Design decisions and trade-offs

Each entry gives the decision, the alternatives considered, and why. These are the things most worth being able to defend.

---

### 1. Modular monolith, two process types

**Decision:** One codebase, one database. An API process and a worker process.
**Alternatives:** Microservices (separate run, provider and auth services); serverless functions.
**Why:** Nothing here needs independent scaling except the workers, and they already scale by running more copies. Microservices would add network calls, distributed transactions and deployment complexity with no benefit at this size.
**Trade-off:** API and worker share code and a database schema, so they must be deployed together.

### 2. Job queue in Postgres (`run_cases`) instead of Redis/BullMQ

**Decision:** Test-case rows are the jobs. Workers claim them with `SELECT … FOR UPDATE SKIP LOCKED`.
**Alternatives:** BullMQ on Redis, RabbitMQ, SQS.
**Why:**

- _Atomicity:_ creating a run and its jobs is one transaction. With a separate queue you write the run to Postgres and then push jobs to Redis. A crash between the two leaves a run with no jobs, or jobs with no run: the **dual-write problem**. The usual fix is a transactional outbox, which is extra machinery.
- _One source of truth:_ job state and results live in the same row and cannot disagree.
- _Fewer moving parts:_ the queue's durability is Postgres's durability.

**Trade-off:** Postgres queues have lower throughput than Redis and need polling (or `LISTEN/NOTIFY`). Each job here waits on an LLM for hundreds of milliseconds to seconds, so the queue is never the bottleneck.
**When I would switch:** very high job rates, or many consumers needing fan-out or priority features that BullMQ provides out of the box.

### 3. Leases + reaper + fencing for crash recovery

**Decision:** A claim sets `lease_expires_at`. A reaper (every 15 s on each worker) returns expired jobs to `PENDING`. Completions require `locked_by = me AND status = 'RUNNING'`.
**Alternatives:** Hold a database transaction open for the whole job (the lock disappears automatically if the worker dies). Or use heartbeats.
**Why:** Holding a transaction open across a 30-second HTTP call ties up a database connection per job and causes long-running-transaction problems. A lease is a timestamp, which costs nothing while held. Fencing covers the case a lease cannot: the original worker was only _slow_, not dead.
**Trade-off:** If a job really takes longer than its lease, it can run twice. That is why `config.js` refuses to start unless the lease exceeds the provider timeout by at least 5 seconds. Heartbeats (extending the lease while working) would allow arbitrarily long jobs; not needed here.

### 4. Retries: full-jitter exponential backoff, honour `Retry-After`, retry only transient errors

**Decision:** 429, 408, 409 and 5xx, network errors and timeouts are retried up to 4 attempts. Delay = random(0, min(60 s, 1 s × 2^(attempt−1))), unless the provider sends `Retry-After`. Other 4xx errors fail immediately.
**Why:**

- Without jitter, every job that hit the same 429 retries at the same moment and triggers another 429 (thundering herd). See the AWS Architecture Blog, "Exponential Backoff and Jitter".
- Retrying a 401 can never succeed and only wastes quota.

**Detail worth knowing:** a retry releases the job back to the queue with `available_at` in the future. It does not `sleep()` while holding it, so the worker's slot is free for other work in the meantime.

### 5. Rate limiting with a Redis token bucket (Lua)

**Decision:** One bucket per provider in Redis. The check-and-take is a Lua script, which Redis runs atomically. Burst = 10% of the per-minute limit.
**Alternatives:** An in-memory limiter per worker; a Postgres counter; a fixed window.
**Why:**

- With N workers, in-memory limits multiply by N.
- Lua makes "read tokens, refill, take one" atomic without locks.
- The script uses Redis `TIME`, so worker clocks do not need to agree.

**Behaviour when limited:** the job is rescheduled for exactly when a token will be available, without counting an attempt.
**When Redis is down:** the limiter fails _closed_ (jobs wait 5 s and try again). The login limiter fails _open_. The reasoning: calling a provider without its shared limit can burn quota for everyone, whereas briefly not throttling logins still requires a correct password.

### 6. Exact-match response cache, not semantic cache

**Decision:** Key = SHA-256 of (project, provider kind, base URL, model, simulator settings, system prompt, rendered prompt, temperature, max tokens). Only used at `temperature = 0`, and only if the run opts in.
**Alternatives:** Semantic cache (embedding similarity), or no cache.
**Why:**

- Semantic caches can return the answer to a _different_ but similar prompt. Vendors document false-positive risk, and in a testing tool a wrong cached answer would hide a regression.
- At temperature above 0, outputs are meant to vary; caching them would hide that variance.
- The project id in the key prevents one tenant's outputs from being served to another.

**Trade-off:** Lower hit rate than semantic caching. Also, a provider silently updating a model behind the same name is not detected; the cache would keep serving the old output. A TTL or a "bypass cache" run (supported via `useCache: false`) addresses this.

### 7. Idempotency keys for the CI API

**Decision:** `Idempotency-Key` header stored on the run with a unique `(project_id, idempotency_key)` index, plus a hash of the request body.
**Why:**

- CI systems retry steps. Without this, a retried step starts a second run, paying twice and possibly reporting a different result.
- The unique index (not a "check then insert") makes it correct under concurrency. When two identical requests race, one insert wins and the other gets `P2002` and returns the winner's run. Tested with 5 parallel requests.
- Reusing a key with a different body returns `422`, the same convention payment APIs use.

### 8. Sessions in Postgres with httpOnly cookies, not JWTs

**Decision:** Random 32-byte session token in an `httpOnly`, `SameSite=Lax` cookie; its SHA-256 is stored in `sessions`.
**Alternatives:** JWT in `localStorage`, or a JWT in a cookie.
**Why:**

- Logout and revocation are immediate: delete the row. A JWT stays valid until it expires unless you build a denylist, which is a session table anyway.
- `httpOnly` keeps the token away from JavaScript, so an XSS bug cannot steal it.
- The extra database lookup per request is negligible here.

**CSRF:** cookies are sent automatically, so state-changing requests also require an `X-CSRF-Token` header that a cross-site page cannot read or forge.

### 9. Vanilla JS frontend, no framework

**Decision:** ES modules served as static files; a 30-line `h()` helper builds DOM nodes; hash routing.
**Alternatives:** React or Vue with a build step.
**Why:**

- The UI is forms and tables; a framework would add a build pipeline, dependencies and concepts without changing what the user sees.
- Building nodes with `textContent` instead of HTML strings makes XSS-safe rendering the default.
- No bundler keeps the CSP strict (`script-src 'self'`, no inline scripts or styles).

**Trade-off:** Re-rendering is manual (views rebuild their section after changes). For a much larger UI, a component framework would pay for itself.

### 10. Deterministic assertions only

**Decision:** `contains`, `regex`, `is_json`, `json_field_equals`, length and latency checks.
**Alternative:** LLM-as-judge ("does this answer the question politely?").
**Why:** A judge is itself non-deterministic and costs a model call per case per run, which is the exact cost problem the research identified. It is the most valuable future addition, and the assertion engine is a single function where it would plug in.

### 11. Prisma plus raw SQL where it matters

**Decision:** Prisma for CRUD. Raw parameterised SQL (`$queryRaw` tagged templates) for claiming jobs, reclaiming leases and finalizing runs.
**Why:** Prisma has no API for `FOR UPDATE SKIP LOCKED`, `UPDATE … FROM (aggregate)` or conditional `CASE` updates. Tagged templates send values as bind parameters, so these queries are still safe from SQL injection.

### 12. SSRF guard, with a known gap

**Decision:** Before every provider call, resolve the hostname and refuse private, loopback, link-local and CGNAT ranges, including IPv4-mapped IPv6. Refuse redirects.
**Known gap:** _DNS rebinding._ The check resolves the name, then `fetch` resolves it again; an attacker-controlled DNS server could answer differently the second time. The fix is to connect to the already-resolved IP (a custom HTTP agent with a `lookup` function). This is documented rather than claimed.

### 13. Things deliberately left out

- **Microservices, Kafka, Kubernetes:** no requirement justifies them.
- **WebSockets for live progress:** polling every 1.5 s on one page is simpler and adequate.
- **Teams and roles:** valuable, but the authorization model (owner-only, with foreign resources returning 404) is the part worth demonstrating.
- **Postgres `LISTEN/NOTIFY` for instant job pickup:** a small improvement over 1 s polling; future work.
