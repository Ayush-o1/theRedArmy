import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  closeConnections,
  createFixture,
  newWorker,
  resetState,
  runToCompletion,
  signedInClient,
  startRun,
} from '../helpers/setup.js';
import { prisma } from '../../src/db.js';
import { claimJobs, completeJob, reclaimExpiredLeases, tryFinalizeRun } from '../../src/engine/queue.js';
import { takeProviderToken } from '../../src/engine/rateLimiter.js';

beforeEach(resetState);
after(closeConnections);

const casesOf = (runId) => prisma.runCase.findMany({ where: { runId }, orderBy: { caseName: 'asc' } });

describe('run lifecycle', () => {
  test('a run executes every case and records pass/fail with reasons', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, {
      cases: [
        {
          name: 'passes',
          variables: { ticket: 'refund please' },
          assertions: [{ type: 'contains', value: 'refund' }],
        },
        {
          name: 'fails',
          variables: { ticket: 'hello' },
          assertions: [{ type: 'contains', value: 'refund' }],
        },
      ],
    });
    const { run } = (await startRun(client, f).expect(202)).body;
    assert.equal(run.status, 'QUEUED');

    const done = await runToCompletion(newWorker(), run.id);
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.totalCases, 2);
    assert.equal(done.passedCases, 1);
    assert.equal(done.failedCases, 1);
    assert.ok(done.costUsd > 0, 'cost is estimated from token counts');

    const [fails, passes] = await casesOf(run.id);
    assert.equal(passes.renderedPrompt, 'Ticket: refund please');
    assert.equal(fails.status, 'FAILED');
    assert.match(fails.assertionResults[0].message, /does not contain "refund"/);
  });

  test('editing a test case after a run does not change that run', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    const { run } = (await startRun(client, f).expect(202)).body;
    const target = f.suite.cases.find((c) => c.name === 'refund');
    await client
      .patch(`${f.base}/suites/${f.suite.id}/cases/${target.id}`, { variables: { ticket: 'changed' } })
      .expect(200);

    await runToCompletion(newWorker(), run.id);
    const snap = (await casesOf(run.id)).find((c) => c.caseName === 'refund');
    assert.equal(snap.renderedPrompt, 'Ticket: I want a refund');
  });

  test('a missing template variable fails that case with a clear error', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, { cases: [{ name: 'no-vars', variables: {} }] });
    const { run } = (await startRun(client, f).expect(202)).body;
    const done = await runToCompletion(newWorker(), run.id);
    assert.equal(done.erroredCases, 1);
    assert.match((await casesOf(run.id))[0].error, /Missing template variable\(s\): ticket/);
  });
});

describe('failure handling', () => {
  test('transient provider errors are retried, then succeed', async () => {
    const client = await signedInClient();
    // The simulator fails every case's first attempt with a 503.
    const f = await createFixture(client, { providerSettings: { failUntilAttempt: 1 } });
    const { run } = (await startRun(client, f).expect(202)).body;

    const done = await runToCompletion(newWorker(), run.id);
    assert.equal(done.passedCases, 3);
    for (const c of await casesOf(run.id)) assert.equal(c.attempts, 2);
  });

  test('a case that keeps failing gives up after maxAttempts', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, {
      providerSettings: { failUntilAttempt: 10 },
      cases: [{ name: 'doomed', variables: { ticket: 'x' } }],
    });
    const { run } = (await startRun(client, f).expect(202)).body;
    // Shrink backoff for the test by making the job available immediately each time.
    const worker = newWorker();
    const deadline = Date.now() + 15_000;
    let done;
    while (Date.now() < deadline) {
      await prisma.runCase.updateMany({
        where: { runId: run.id, status: 'PENDING' },
        data: { availableAt: new Date() },
      });
      await worker.tick();
      await worker.drain();
      done = await prisma.run.findUnique({ where: { id: run.id } });
      if (done.status === 'COMPLETED') break;
    }
    assert.equal(done.erroredCases, 1);
    const [c] = await casesOf(run.id);
    assert.equal(c.attempts, 4);
    assert.match(c.error, /Gave up after 4 attempts/);
  });
});

describe('concurrency and crash recovery', () => {
  test('two workers on the same run never process a case twice', async () => {
    const client = await signedInClient();
    const cases = Array.from({ length: 30 }, (_, i) => ({
      name: `case-${i}`,
      variables: { ticket: `t${i}` },
    }));
    const f = await createFixture(client, { cases, providerSettings: { latencyMs: 20 } });
    const { run } = (await startRun(client, f, { useCache: false }).expect(202)).body;

    const a = newWorker({ concurrency: 5 });
    const b = newWorker({ concurrency: 5 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      // Both workers claim in parallel, which is exactly the race SKIP LOCKED handles.
      await Promise.all([a.tick(), b.tick()]);
      await Promise.all([a.drain(), b.drain()]);
      if ((await prisma.run.findUnique({ where: { id: run.id } })).status === 'COMPLETED') break;
    }
    const rows = await casesOf(run.id);
    assert.equal(rows.length, 30);
    assert.ok(
      rows.every((c) => c.status === 'PASSED' && c.attempts === 1),
      'each case ran exactly once',
    );
  });

  test('jobs held by a crashed worker are recovered, and its late result is discarded', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, { cases: [{ name: 'only', variables: { ticket: 'x' } }] });
    const { run } = (await startRun(client, f).expect(202)).body;

    // "Worker A" claims the job and then dies without finishing it.
    const [job] = await claimJobs('crashed-worker', 1, 30);
    assert.ok(job);
    await prisma.runCase.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const { reclaimed } = await reclaimExpiredLeases();
    assert.equal(reclaimed, 1);

    const done = await runToCompletion(newWorker(), run.id);
    assert.equal(done.passedCases, 1);

    // Worker A wakes up and tries to write its stale result: fenced out.
    const accepted = await completeJob(job.id, 'crashed-worker', { status: 'FAILED', output: 'stale' });
    assert.equal(accepted, false);
    assert.equal((await casesOf(run.id))[0].status, 'PASSED');
  });

  test('a job whose worker keeps dying gives up at maxAttempts and the run still finishes', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, { cases: [{ name: 'poison', variables: { ticket: 'x' } }] });
    const { run } = (await startRun(client, f).expect(202)).body;

    // Simulate the last allowed attempt being claimed by a worker that then died.
    const [job] = await claimJobs('dying-worker', 1, 30);
    await prisma.runCase.update({
      where: { id: job.id },
      data: { attempts: 4, leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    await newWorker().reap();
    const [c] = await casesOf(run.id);
    assert.equal(c.status, 'ERROR');
    assert.match(c.error, /lease expired on the final attempt/);
    const final = await prisma.run.findUnique({ where: { id: run.id } });
    assert.equal(final.status, 'COMPLETED', 'the reaper finalizes the run');
    assert.equal(final.erroredCases, 1);
  });

  test('finalization is idempotent under concurrent calls', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    const { run } = (await startRun(client, f).expect(202)).body;
    await prisma.runCase.updateMany({ where: { runId: run.id }, data: { status: 'PASSED' } });

    const results = await Promise.all(Array.from({ length: 8 }, () => tryFinalizeRun(run.id)));
    assert.equal(results.filter(Boolean).length, 1, 'exactly one caller finalizes');
    const final = await prisma.run.findUnique({ where: { id: run.id } });
    assert.equal(final.status, 'COMPLETED');
    assert.equal(final.passedCases, 3);
  });

  test('the shared token bucket throttles across callers', async () => {
    // 60 rpm => burst capacity of 6, then roughly one token per second.
    const waits = [];
    for (let i = 0; i < 8; i += 1) waits.push(await takeProviderToken('bucket-test', 60));
    assert.deepEqual(waits.slice(0, 6), [0, 0, 0, 0, 0, 0]);
    assert.ok(waits[6] > 0 && waits[6] <= 1000, `7th call should wait, got ${waits[6]}`);
  });

  test('a rate-limited job is postponed without using up a retry', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, { cases: [{ name: 'a', variables: { ticket: 'x' } }] });
    await client.patch(`${f.base}/providers/${f.provider.id}`, { requestsPerMinute: 1 }).expect(200);
    await takeProviderToken(f.provider.id, 1); // drain the single token
    const { run } = (await startRun(client, f).expect(202)).body;

    const worker = newWorker();
    await worker.tick();
    await worker.drain();
    const [c] = await casesOf(run.id);
    assert.equal(c.status, 'PENDING');
    assert.equal(c.attempts, 0);
    assert.ok(c.availableAt > new Date(), 'rescheduled for later');
  });
});

describe('cost control: response cache', () => {
  test('re-running an unchanged prompt is served from cache at zero cost', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    const first = (await startRun(client, f).expect(202)).body.run;
    const firstDone = await runToCompletion(newWorker(), first.id);
    assert.equal(firstDone.cachedCases, 0);

    const second = (await startRun(client, f).expect(202)).body.run;
    const secondDone = await runToCompletion(newWorker(), second.id);
    assert.equal(secondDone.cachedCases, 3);
    assert.equal(secondDone.costUsd, 0);
    assert.equal(secondDone.passedCases, 3);
  });

  test('cache is bypassed when temperature > 0 (sampling is meant to vary)', async () => {
    const client = await signedInClient();
    const f = await createFixture(client, { temperature: 0.7 });
    await runToCompletion(newWorker(), (await startRun(client, f).expect(202)).body.run.id);
    const again = await runToCompletion(newWorker(), (await startRun(client, f).expect(202)).body.run.id);
    assert.equal(again.cachedCases, 0);
    assert.equal(await prisma.cachedResponse.count(), 0);
  });

  test("one project's cache is never served to another project", async () => {
    const alice = await signedInClient();
    const bob = await signedInClient();
    const a = await createFixture(alice);
    const b = await createFixture(bob);
    await runToCompletion(newWorker(), (await startRun(alice, a).expect(202)).body.run.id);
    const bobRun = await runToCompletion(newWorker(), (await startRun(bob, b).expect(202)).body.run.id);
    assert.equal(bobRun.cachedCases, 0, 'identical prompt, different tenant: no cache hit');
  });
});

describe('cancellation and comparison', () => {
  test('cancelling stops queued work and is rejected once finished', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    const { run } = (await startRun(client, f).expect(202)).body;

    const res = await client.post(`${f.base}/runs/${run.id}/cancel`).expect(200);
    assert.equal(res.body.run.status, 'CANCELLED');
    const rows = await casesOf(run.id);
    assert.ok(rows.every((c) => c.status === 'CANCELLED'));

    // Workers ignore cancelled runs.
    const worker = newWorker();
    assert.equal(await worker.tick(), 0);
    await client.post(`${f.base}/runs/${run.id}/cancel`).expect(409);
  });

  test('comparing two versions surfaces the regression and fails the gate', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    const v1 = (await startRun(client, f).expect(202)).body.run;
    await runToCompletion(newWorker(), v1.id);

    // v2 drops the ticket text, so every "contains" assertion now fails.
    const v2version = (
      await client
        .post(`${f.base}/prompts/${f.prompt.id}/versions`, { template: 'Ticket received.' })
        .expect(201)
    ).body.version;
    const v2 = (
      await startRun(client, f, { promptVersionId: v2version.id, baselineRunId: v1.id }).expect(202)
    ).body.run;
    await runToCompletion(newWorker(), v2.id);

    const cmp = await client.get(`${f.base}/runs/compare?base=${v1.id}&head=${v2.id}`).expect(200);
    assert.equal(cmp.body.summary.regressed, 3);
    assert.equal(cmp.body.items[0].category, 'regressed');
    assert.equal(cmp.body.items[0].base.status, 'PASSED');

    const detail = await client.get(`${f.base}/runs/${v2.id}`).expect(200);
    assert.equal(detail.body.run.gate.status, 'failed');
    assert.match(detail.body.run.gate.reasons[0], /3 case\(s\) regressed/);
  });

  test('run list uses cursor pagination without duplicates', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    for (let i = 0; i < 5; i += 1) await startRun(client, f).expect(202);

    const seen = [];
    let cursor = null;
    do {
      const qs = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = (await client.get(`${f.base}/runs${qs}`).expect(200)).body;
      seen.push(...page.runs.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
  });
});

describe('OpenAI-compatible provider', () => {
  // A stand-in for a real provider: returns 429 with Retry-After once, then
  // answers. Lets us test the HTTP adapter without a paid API key.
  function startMockProvider(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('honours 429 Retry-After, sends the decrypted key, parses usage', async () => {
    let calls = 0;
    let authHeader;
    const server = await startMockProvider((req, res) => {
      calls += 1;
      authHeader = req.headers.authorization;
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '0' }).end('{"error":"slow down"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ message: { content: 'refund approved' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
    });
    try {
      const client = await signedInClient();
      const f = await createFixture(client, {
        cases: [
          { name: 'r', variables: { ticket: 'x' }, assertions: [{ type: 'contains', value: 'refund' }] },
        ],
      });
      const provider = (
        await client
          .post(`${f.base}/providers`, {
            name: 'mock-openai',
            kind: 'OPENAI_COMPATIBLE',
            model: 'mock',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: 'sk-mock-key',
          })
          .expect(201)
      ).body.provider;
      const { run } = (await startRun(client, f, { providerConfigId: provider.id }).expect(202)).body;
      const done = await runToCompletion(newWorker(), run.id);

      assert.equal(done.passedCases, 1);
      assert.equal(calls, 2);
      assert.equal(authHeader, 'Bearer sk-mock-key');
      const [c] = await casesOf(run.id);
      assert.equal(c.inputTokens, 12);
      assert.equal(c.attempts, 2);
    } finally {
      server.close();
    }
  });

  test('a 401 is not retried', async () => {
    let calls = 0;
    const server = await startMockProvider((req, res) => {
      calls += 1;
      res.writeHead(401).end('bad key');
    });
    try {
      const client = await signedInClient();
      const f = await createFixture(client, { cases: [{ name: 'r', variables: { ticket: 'x' } }] });
      const provider = (
        await client
          .post(`${f.base}/providers`, {
            name: 'mock-openai',
            kind: 'OPENAI_COMPATIBLE',
            model: 'mock',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          })
          .expect(201)
      ).body.provider;
      const { run } = (await startRun(client, f, { providerConfigId: provider.id }).expect(202)).body;
      const done = await runToCompletion(newWorker(), run.id);
      assert.equal(done.erroredCases, 1);
      assert.equal(calls, 1);
      assert.match((await casesOf(run.id))[0].error, /HTTP 401/);
    } finally {
      server.close();
    }
  });
});
