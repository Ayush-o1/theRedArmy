import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnections, createFixture, resetState, signedInClient } from '../helpers/setup.js';
import { prisma } from '../../src/db.js';
import { decrypt } from '../../src/lib/crypto.js';

beforeEach(resetState);
after(closeConnections);

test('provider API keys are encrypted at rest and never returned', async () => {
  const client = await signedInClient();
  const { base } = await createFixture(client);
  const res = await client
    .post(`${base}/providers`, {
      name: 'openai',
      kind: 'OPENAI_COMPATIBLE',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-1234567890abcd',
    })
    .expect(201);

  assert.equal(res.body.provider.hasApiKey, true);
  assert.equal(res.body.provider.apiKeyLast4, 'abcd');
  assert.ok(!JSON.stringify(res.body).includes('sk-test'), 'key not in response');

  const row = await prisma.providerConfig.findUnique({ where: { id: res.body.provider.id } });
  assert.ok(!row.apiKeyCiphertext.includes('sk-test'));
  assert.equal(decrypt(row.apiKeyCiphertext), 'sk-test-1234567890abcd');

  // PATCH with apiKey: null removes the key.
  const cleared = await client.patch(`${base}/providers/${row.id}`, { apiKey: null }).expect(200);
  assert.equal(cleared.body.provider.hasApiKey, false);
});

test('OpenAI-compatible providers require a base URL with a safe scheme', async () => {
  const client = await signedInClient();
  const { base } = await createFixture(client);
  const body = { name: 'x', kind: 'OPENAI_COMPATIBLE', model: 'm' };
  await client.post(`${base}/providers`, body).expect(400);
  await client.post(`${base}/providers`, { ...body, baseUrl: 'ftp://example.com' }).expect(400);
});

test('concurrent saves of a prompt get distinct, gap-free version numbers', async () => {
  const client = await signedInClient();
  const { base, prompt } = await createFixture(client);

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      client.post(`${base}/prompts/${prompt.id}/versions`, { template: `v${i} {{ticket}}` }),
    ),
  );
  for (const r of responses) assert.equal(r.status, 201);
  const numbers = responses.map((r) => r.body.version.version).sort((a, b) => a - b);
  assert.deepEqual(numbers, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('prompt versions expose the variables their template uses', async () => {
  const client = await signedInClient();
  const { base, prompt } = await createFixture(client);
  const res = await client
    .post(`${base}/prompts/${prompt.id}/versions`, { template: '{{name}} asked about {{topic}}' })
    .expect(201);
  assert.deepEqual(res.body.version.variables, ['name', 'topic']);
});

test('suites reject invalid assertions and duplicate case names', async () => {
  const client = await signedInClient();
  const { base, suite } = await createFixture(client);
  const bad = await client
    .post(`${base}/suites/${suite.id}/cases`, {
      cases: [{ name: 'x', assertions: [{ type: 'regex', pattern: '(' }] }],
    })
    .expect(400);
  assert.match(JSON.stringify(bad.body.error.details), /Invalid regular expression/);

  await client.post(`${base}/suites/${suite.id}/cases`, { cases: [{ name: 'refund' }] }).expect(409);
});

test('bulk case import is all-or-nothing', async () => {
  const client = await signedInClient();
  const { base, suite } = await createFixture(client);
  await client
    .post(`${base}/suites/${suite.id}/cases`, { cases: [{ name: 'new-one' }, { name: 'refund' }] })
    .expect(409);
  const after = await client.get(`${base}/suites/${suite.id}`).expect(200);
  assert.equal(after.body.suite.cases.length, 3, 'the valid first case was rolled back too');
});

test('resources used by runs cannot be deleted out from under their history', async () => {
  const client = await signedInClient();
  const f = await createFixture(client);
  const run = (
    await client
      .post(`${f.base}/runs`, {
        promptVersionId: f.version.id,
        suiteId: f.suite.id,
        providerConfigId: f.provider.id,
      })
      .expect(202)
  ).body.run;

  await client.delete(`${f.base}/providers/${f.provider.id}`).expect(409);
  await client.delete(`${f.base}/suites/${f.suite.id}`).expect(409);
  await client.delete(`${f.base}/runs/${run.id}`).expect(409); // still queued

  // Deleting the project cleans up everything, including the run.
  await client.delete(f.base).expect(204);
  assert.equal(await prisma.run.count(), 0);
});
