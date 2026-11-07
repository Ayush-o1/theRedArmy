# CI and regression gates

This page covers two different things that both involve "CI":

1. **The repository's own pipeline:** the GitHub Actions workflow that tests theRedArmy itself.
2. **Using theRedArmy as a gate in another project's CI:** calling its API to fail a build when a prompt change regresses.

## 1. The repository's pipeline

One workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

**Triggers:** every push to `main`, and every pull request (any branch). Pushes to other branches without a pull request do not run it.

**Environment:** `ubuntu-latest`, Node 24 with the npm cache, and two service containers:

- `postgres:17-alpine`, with user and password `theredarmy` and database `theredarmy_test`
- `redis:7.4-alpine`

Both have health checks, so the job waits until they accept connections. The `ENCRYPTION_KEY` is generated freshly for each run, so no secret is stored in the repository.

**Steps, in order** (any failure stops the job):

| Step                            | Command                                       | Catches                                                        |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Install                         | `npm ci`                                      | Lockfile out of sync with `package.json`                       |
| Lint                            | `npm run lint`                                | ESLint errors (unused code, unsafe equality, undefined names)  |
| Formatting                      | `npm run format:check`                        | Files not formatted with Prettier                              |
| Unit and integration tests      | `npm test`                                    | Logic, API, database and concurrency regressions               |
| Install browser                 | `npx playwright install --with-deps chromium` |                                                                |
| End-to-end tests                | `npm run test:e2e`                            | Broken user journeys in a real browser                         |
| Upload traces (only on failure) | `actions/upload-artifact`                     | Saves `test-results/` for 7 days                               |
| Dependency audit                | `npm audit --omit=dev --audit-level=high`     | Known high-severity vulnerabilities in production dependencies |

The job has a 20-minute timeout and only `contents: read` permission.

### Investigating a failure

1. Open the failed run under the repository's **Actions** tab and expand the red step.
2. **Lint or formatting:** run `npm run lint` or `npm run format` locally and commit the result.
3. **`npm test`:** the failing test name is printed with an assertion diff. Reproduce it with `node --env-file=.env.test --test test/integration/<file>.test.js`.
4. **End-to-end:** download the `playwright-traces` artifact from the run's summary page and open it with `npx playwright show-trace <path>/trace.zip`. It replays the browser session step by step.
5. **Audit:** `npm audit --omit=dev` shows the vulnerable package and the version that fixes it.

### Does CI block merges?

**Not currently.** `main` has no branch-protection rule, so a pull request can be merged with a failing check. To make it a hard gate, add a ruleset in **Settings → Rules** (or **Branches**) that requires the `test` status check to pass before merging.

### Not automated

There is no deployment step (there is no hosted environment), no release automation and no coverage measurement.

## 2. Using theRedArmy as a regression gate

A pipeline in another repository can start a run when a prompt changes, then fail the build if the gate fails. The API is described in [api.md](api.md#ci-api-apiv1-api-key); the gate rules are in [architecture.md](architecture.md#3-ci-gate).

In short:

- Create an API key under **Settings & CI** in the UI. Store it as a secret (for example `THEREDARMY_KEY`), with the server's address in `THEREDARMY_URL`.
- `POST /api/v1/runs` with prompt, suite and provider **names**. Use `"baseline": "previous"` to compare with the previous prompt version, and send the commit SHA as `Idempotency-Key`, so a retried step returns the same run instead of starting another.
- Poll `GET /api/v1/runs/:id` until `run.gate.status` is `passed` or `failed`.
- With a baseline, only **regressions** (passed before, fail now) fail the gate; cases that were already failing do not. Any **errored** case always fails it.

### Example GitHub Actions job

This needs a theRedArmy server that GitHub's runners can reach. It uses only `curl` and `jq`, both preinstalled on `ubuntu-latest`.

```yaml
prompt-regression:
  runs-on: ubuntu-latest
  steps:
    - name: Run the prompt regression gate
      env:
        THEREDARMY_URL: ${{ secrets.THEREDARMY_URL }}
        THEREDARMY_KEY: ${{ secrets.THEREDARMY_KEY }}
      run: |
        run_id=$(curl -sf -X POST "$THEREDARMY_URL/api/v1/runs" \
          -H "Authorization: Bearer $THEREDARMY_KEY" \
          -H "Content-Type: application/json" \
          -H "Idempotency-Key: $GITHUB_SHA" \
          -d '{"prompt":"ticket-reply","suite":"core-tickets","provider":"simulator","baseline":"previous"}' \
          | jq -r .run.id)
        echo "Run $run_id"
        for i in $(seq 1 60); do
          run=$(curl -sf "$THEREDARMY_URL/api/v1/runs/$run_id" -H "Authorization: Bearer $THEREDARMY_KEY")
          gate=$(echo "$run" | jq -r .run.gate.status)
          [ "$gate" != "pending" ] && break
          sleep 10
        done
        echo "$run" | jq '.run.gate, .run.notPassing'
        [ "$gate" = "passed" ]
```

The step fails (non-zero exit) when the gate is `failed`, or still `pending` after 10 minutes. The loop body was run against a local server with the seeded demo data: it printed the failed gate with its seven regressed cases and exited 1.
