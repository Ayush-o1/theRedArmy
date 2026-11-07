# API reference

Base URL: `http://localhost:3000`. All bodies are JSON.

## Conventions

**Errors** always look like this:

```json
{
  "error": {
    "code": "bad_request",
    "message": "Validation failed",
    "details": [{ "path": "email", "message": "Invalid email address" }]
  }
}
```

| Status | `code`              | When                                                                                       |
| ------ | ------------------- | ------------------------------------------------------------------------------------------ |
| 400    | `bad_request`       | Validation failed or malformed JSON                                                        |
| 401    | `unauthorized`      | Not logged in, or bad API key                                                              |
| 403    | `forbidden`         | Missing or invalid CSRF token                                                              |
| 404    | `not_found`         | Does not exist, **or belongs to another user** (deliberately the same response)            |
| 409    | `conflict`          | Duplicate name, resource still used by runs, run already finished                          |
| 413    | `payload_too_large` | Body over 1 MB                                                                             |
| 422    | `unprocessable`     | Valid shape but cannot be done (empty suite, reused Idempotency-Key with a different body) |
| 429    | `rate_limited`      | Too many requests; see the `Retry-After` header                                            |
| 500    | `internal_error`    | Bug; the response includes a `requestId` to find in the logs                               |

Every response has an `X-Request-Id` header.

**Authentication**

- _Browser API_ (`/api/auth`, `/api/projects`): session cookie `pg_session`. Every `POST`/`PATCH`/`DELETE` must send `X-CSRF-Token`, whose value comes from signup, login or `GET /api/auth/me`.
- _CI API_ (`/api/v1`): `Authorization: Bearer pgk_…`. Keys are project-scoped. No cookies and no CSRF token.

## Health

`GET /api/health` → `200 {"status":"ok","checks":{"database":"ok","redis":"ok"}}`, or `503` with `"degraded"`.

## Auth: `/api/auth`

| Method | Path      | Body                                            | Response                                                                   |
| ------ | --------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| POST   | `/signup` | `{email, name, password}` (password ≥ 10 chars) | `201 {user, csrfToken}` + cookie                                           |
| POST   | `/login`  | `{email, password}`                             | `200 {user, csrfToken}` + cookie. Rate limit: 10 per 15 min per IP + email |
| POST   | `/logout` | —                                               | `204`                                                                      |
| GET    | `/me`     | —                                               | `200 {user, csrfToken}` or `401`                                           |

## Projects: `/api/projects`

| Method | Path          | Notes                                  |
| ------ | ------------- | -------------------------------------- |
| GET    | `/`           | Your projects with counts and last run |
| POST   | `/`           | `{name, description?}` → `201`         |
| GET    | `/:projectId` |                                        |
| PATCH  | `/:projectId` | `{name?, description?}`                |
| DELETE | `/:projectId` | Deletes everything inside it → `204`   |

Everything below is nested under `/api/projects/:projectId`.

## Providers: `/providers`

| Method | Path           | Notes                                                        |
| ------ | -------------- | ------------------------------------------------------------ |
| GET    | `/`            | Never includes the API key; shows `hasApiKey`, `apiKeyLast4` |
| POST   | `/`            | See below → `201`                                            |
| PATCH  | `/:providerId` | Any field except `kind`. `apiKey: null` removes the key      |
| DELETE | `/:providerId` | `409` if runs use it                                         |

```json
{
  "name": "gpt-4o-mini",
  "kind": "OPENAI_COMPATIBLE",
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "requestsPerMinute": 60,
  "inputCostPerMTok": 0.15,
  "outputCostPerMTok": 0.6
}
```

For `"kind": "SIMULATED"`, `settings` may contain:

| Setting            | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `latencyMs`        | Delay per call (0–10000)                                              |
| `mode`             | `"echo"` (return the prompt) or `"json"` (return `{"input": prompt}`) |
| `errorRate`        | Probability (0–1) of a 503                                            |
| `rateLimitRate`    | Probability (0–1) of a 429                                            |
| `failUntilAttempt` | Deterministically return 503 while `attempt ≤ n`, used by tests       |

`baseUrl` is rejected if it is not http(s), contains credentials, or resolves to a private, loopback or link-local address (unless `ALLOW_PRIVATE_PROVIDER_URLS=true`).

## Prompts: `/prompts`

| Method | Path                  | Notes                                                                                                    |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| GET    | `/`                   | Each prompt with its latest version and that version's `variables`                                       |
| POST   | `/`                   | `{name, description?, version: {template, systemPrompt?, temperature?, maxTokens?, note?}}` → creates v1 |
| GET    | `/:promptId`          | All versions, newest first                                                                               |
| POST   | `/:promptId/versions` | Same fields as `version` above → next version number                                                     |
| DELETE | `/:promptId`          | `409` if runs use any version                                                                            |

Templates use `{{variable}}` placeholders. A missing variable makes that case `ERROR`, never an empty string.

## Suites: `/suites`

| Method | Path                      | Notes                                                           |
| ------ | ------------------------- | --------------------------------------------------------------- |
| GET    | `/`                       | With `caseCount`                                                |
| POST   | `/`                       | `{name, description?, cases?: [...]}`                           |
| GET    | `/:suiteId`               | With all cases                                                  |
| PATCH  | `/:suiteId`               | `{name?, description?}`                                         |
| DELETE | `/:suiteId`               | `409` if runs use it                                            |
| POST   | `/:suiteId/cases`         | `{cases: [...]}` (1–500). All-or-nothing                        |
| PATCH  | `/:suiteId/cases/:caseId` | Any case field. Past runs are unaffected (they keep a snapshot) |
| DELETE | `/:suiteId/cases/:caseId` |                                                                 |

A case:

```json
{
  "name": "refund-request",
  "variables": {
    "customer_name": "Ishita Sharma",
    "order_id": "MM-240117",
    "ticket": "I was charged twice by UPI"
  },
  "assertions": [
    { "type": "contains", "value": "MM-240117" },
    { "type": "not_contains", "value": "password" },
    { "type": "regex", "pattern": "^Hi", "flags": "i" },
    { "type": "max_length", "value": 600 },
    { "type": "is_json" },
    { "type": "json_field_equals", "path": "category", "value": "billing" },
    { "type": "latency_under_ms", "value": 3000 }
  ]
}
```

| Assertion                   | Fields                                      | Passes when                                            |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `contains` / `not_contains` | `value`, `caseSensitive` (default `false`)  | Output does / does not include `value`                 |
| `equals`                    | `value`, `trim` (default `true`)            | Output equals `value` exactly                          |
| `regex`                     | `pattern` (≤ 200 chars), `flags` (`imsu`)   | Pattern matches                                        |
| `min_length` / `max_length` | `value`                                     | Character count within bound                           |
| `is_json`                   | —                                           | Output parses as JSON (a ` ```json ` fence is allowed) |
| `json_field_equals`         | `path` (dot path, e.g. `labels.0`), `value` | Field equals value (typed: `42` ≠ `"42"`)              |
| `latency_under_ms`          | `value`                                     | Provider latency below value (skipped for cache hits)  |

## Runs: `/runs`

| Method | Path                   | Notes                                                                                           |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/`                    | Query: `limit` (1–100), `cursor`, `promptId`, `suiteId`, `status`. Returns `{runs, nextCursor}` |
| POST   | `/`                    | `{promptVersionId, suiteId, providerConfigId, baselineRunId?, useCache?}` → `202 {run}`         |
| GET    | `/:runId`              | Run with `progress` (live counts), `cases`, `comparison` (if baseline), `gate`                  |
| GET    | `/compare?base=&head=` | `{base, head, warnings, summary, items}`                                                        |
| POST   | `/:runId/cancel`       | `409` if already finished                                                                       |
| DELETE | `/:runId`              | `409` while queued or running                                                                   |

**Pagination** is cursor-based: pass the previous page's `nextCursor`. It stays stable when new runs are created while you page.

**Comparison categories:** `regressed`, `fixed`, `still_failing`, `still_passing`, `added`, `removed`, `pending`, `other`. `summary.outputChanged` counts cases whose output text differs.

## API keys: `/api-keys`

| Method | Path      | Notes                                                        |
| ------ | --------- | ------------------------------------------------------------ |
| GET    | `/`       | Name, prefix, created, last used, revoked. Never the key     |
| POST   | `/`       | `{name}` → `201 {apiKey, key}`. **`key` is shown only once** |
| DELETE | `/:keyId` | Revokes (keeps the row for history)                          |

## CI API: `/api/v1` (API key)

Rate limit: 120 requests per minute per key.

### `POST /api/v1/runs`

Headers: `Authorization: Bearer pgk_…`, optional `Idempotency-Key` (1–200 chars of `A-Z a-z 0-9 . _ : -`).

```json
{
  "prompt": "ticket-reply",
  "version": 3,
  "suite": "core-tickets",
  "provider": "simulator",
  "baseline": "previous",
  "useCache": true
}
```

- `version` defaults to the latest.
- `baseline`: `"previous"` (latest completed run of an earlier version with the same suite and provider; none on the very first run), a run id, or omitted.

| Response                            | Meaning                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `202`                               | New run created                                                           |
| `200` + `Idempotent-Replayed: true` | Same key and same body as an earlier request: the earlier run is returned |
| `422`                               | Same key, different body                                                  |
| `404`                               | Unknown prompt, suite, provider or version (the message names which)      |

### `GET /api/v1/runs/:runId`

```json
{
  "run": {
    "id": "389d01cc-c064-411a-b21e-b68b2a006532",
    "status": "COMPLETED",
    "prompt": "ticket-reply",
    "version": 2,
    "suite": "core-tickets",
    "provider": "simulator",
    "baselineRunId": "c1aacdfe-ad26-4ea7-981e-a29a76a88526",
    "totals": { "cases": 8, "passed": 1, "failed": 7, "errored": 0, "cached": 0, "costUsd": 0.0003156 },
    "progress": { "PASSED": 1, "FAILED": 7 },
    "comparison": {
      "regressed": 7,
      "fixed": 0,
      "still_failing": 0,
      "added": 0,
      "removed": 0,
      "pending": 0,
      "other": 0,
      "still_passing": 1,
      "outputChanged": 8
    },
    "gate": { "status": "failed", "reasons": ["7 case(s) regressed against the baseline"] },
    "notPassing": [
      { "name": "cancel-before-dispatch", "status": "FAILED", "error": null },
      { "name": "change-address", "status": "FAILED", "error": null }
    ]
  }
}
```

This is a real response for the seeded demo's v2 run (`notPassing` shortened to two of its seven entries).

Poll until `gate.status` is `passed` or `failed`, then exit non-zero on `failed`.
