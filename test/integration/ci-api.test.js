import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  app,
  closeConnections,
  createFixture,
  newWorker,
  resetState,
  runToCompletion,
  signedInClient,
} from '../helpers/setup.js';
import { prisma } from '../../src/db.js';

beforeEach(resetState);
after(closeConnections);

async function setup() {
  const client = await signedInClient();
  const f = await createFixture(client);
  const created = await client.post(`${f.base}/api-keys`, { name: 'github-actions' }).expect(201);
  return { client, f, key: created.body.key, keyId: created.body.apiKey.id };
}

const body = { prompt: 'triage', suite: 'core', provider: 'sim' };
const ci = (key) => ({
  start: (payload, idem) => {
    const req = request(app).post('/api/v1/runs').set('authorization', `Bearer ${key}`);
    if (idem) req.set('idempotency-key', idem);
    return req.send(payload);
  },
  get: (id) => request(app).get(`/api/v1/runs/${id}`).set('authorization', `Bearer ${key}`),
});

test('API keys are shown once and stored only as a hash', async () => {
  const { client, f, key } = await setup();
  assert.match(key, /^pgk_/);
  const list = await client.get(`${f.base}/api-keys`).expect(200);
  assert.ok(!JSON.stringify(list.body).includes(key));
  const row = await prisma.apiKey.findFirst();
  assert.notEqual(row.keyHash, key);
});

test('CI starts a run by name and polls it to a gate decision', async () => {
  const { key } = await setup();
  const started = await ci(key).start(body).expect(202);
  assert.equal(started.body.run.version, 1);
  assert.equal(started.body.run.gate.status, 'pending');

  await runToCompletion(newWorker(), started.body.run.id);
  const polled = await ci(key).get(started.body.run.id).expect(200);
  assert.equal(polled.body.run.status, 'COMPLETED');
  assert.equal(polled.body.run.gate.status, 'passed');
  assert.deepEqual(polled.body.run.notPassing, []);
});

test('the same Idempotency-Key returns the original run instead of a duplicate', async () => {
  const { key } = await setup();
  const first = await ci(key).start(body, 'commit-abc123').expect(202);
  const retry = await ci(key).start(body, 'commit-abc123').expect(200);
  assert.equal(retry.headers['idempotent-replayed'], 'true');
  assert.equal(retry.body.run.id, first.body.run.id);
  assert.equal(await prisma.run.count(), 1);
});

test('concurrent requests with the same Idempotency-Key create exactly one run', async () => {
  const { key } = await setup();
  const responses = await Promise.all(Array.from({ length: 5 }, () => ci(key).start(body, 'race-key')));
  const ids = new Set(responses.map((r) => r.body.run.id));
  assert.equal(ids.size, 1);
  assert.equal(await prisma.run.count(), 1);
});

test('reusing an Idempotency-Key with a different body is rejected', async () => {
  const { key } = await setup();
  await ci(key).start(body, 'k1').expect(202);
  const res = await ci(key)
    .start({ ...body, useCache: false }, 'k1')
    .expect(422);
  assert.match(res.body.error.message, /different request/);
});

test('baseline "previous" compares against the last run of an earlier version', async () => {
  const { client, f, key } = await setup();
  const v1 = await ci(key).start(body).expect(202);
  await runToCompletion(newWorker(), v1.body.run.id);

  await client
    .post(`${f.base}/prompts/${f.prompt.id}/versions`, { template: 'Ticket received.' })
    .expect(201);
  const v2 = await ci(key)
    .start({ ...body, baseline: 'previous' })
    .expect(202);
  assert.equal(v2.body.run.version, 2);
  assert.equal(v2.body.run.baselineRunId, v1.body.run.id);

  await runToCompletion(newWorker(), v2.body.run.id);
  const polled = await ci(key).get(v2.body.run.id).expect(200);
  assert.equal(polled.body.run.gate.status, 'failed');
  assert.equal(polled.body.run.comparison.regressed, 3);
  assert.equal(polled.body.run.notPassing.length, 3);
});

test('unknown names are reported clearly', async () => {
  const { key } = await setup();
  const res = await ci(key)
    .start({ ...body, suite: 'nope' })
    .expect(404);
  assert.match(res.body.error.message, /Suite "nope"/);
});

test('keys only work for their own project, and revoked keys stop working', async () => {
  const { client, f, key, keyId } = await setup();
  const other = await signedInClient();
  const otherFixture = await createFixture(other);
  const otherRun = (
    await other
      .post(`${otherFixture.base}/runs`, {
        promptVersionId: otherFixture.version.id,
        suiteId: otherFixture.suite.id,
        providerConfigId: otherFixture.provider.id,
      })
      .expect(202)
  ).body.run;
  await ci(key).get(otherRun.id).expect(404);

  await client.delete(`${f.base}/api-keys/${keyId}`).expect(204);
  await ci(key).start(body).expect(401);
  await request(app).post('/api/v1/runs').send(body).expect(401);
});
