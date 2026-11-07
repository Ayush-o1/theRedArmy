import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { listVariables, renderTemplate, TemplateError } from '../../src/engine/template.js';
import { computeBackoffMs, parseRetryAfter } from '../../src/engine/backoff.js';
import { bucketParams } from '../../src/engine/rateLimiter.js';
import { isRetryableStatus } from '../../src/engine/providers/providerError.js';
import { assertSafeProviderUrl, isPrivateAddress } from '../../src/engine/providers/urlGuard.js';
import { decrypt, encrypt, hashPassword, verifyPassword } from '../../src/lib/crypto.js';

import { redis } from '../../src/redis.js';

// rateLimiter.js opens the shared Redis connection on import; close it so the
// test process can exit.
after(() => redis.quit());
test('template: renders variables and lists them once each', () => {
  assert.equal(
    renderTemplate('Hi {{ name }}, re: {{topic}}', { name: 'Priya', topic: 'refund' }),
    'Hi Priya, re: refund',
  );
  assert.deepEqual(listVariables('{{a}} {{b}} {{a}}'), ['a', 'b']);
});

test('template: non-string values are rendered as JSON', () => {
  assert.equal(renderTemplate('Items: {{items}}', { items: [1, 2] }), 'Items: [1,2]');
});

test('template: a missing variable is an error, not an empty string', () => {
  assert.throws(() => renderTemplate('Hello {{name}}', {}), TemplateError);
});

test('backoff: grows exponentially, stays under the cap, uses jitter', () => {
  const max = () => 0.999999;
  assert.equal(computeBackoffMs(1, { random: max }), 999);
  assert.equal(computeBackoffMs(3, { random: max }), 3999);
  assert.equal(computeBackoffMs(20, { random: max }), 59_999);
  assert.equal(computeBackoffMs(3, { random: () => 0 }), 0);
});

test('backoff: Retry-After from the provider wins', () => {
  assert.equal(computeBackoffMs(1, { retryAfterMs: 7000 }), 7000);
  assert.equal(parseRetryAfter('3'), 3000);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('nonsense'), null);
});

test('retryable status codes', () => {
  for (const s of [408, 429, 500, 503]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('token bucket parameters', () => {
  assert.deepEqual(bucketParams(60), { capacity: 6, refillPerMs: 0.001 });
  assert.equal(bucketParams(3).capacity, 1);
});

test('SSRF guard: private, loopback, link-local and mapped addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:10.0.0.1',
    'fd00::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('SSRF guard: rejects bad schemes, credentials and private IP literals', async () => {
  const opts = { allowPrivate: false };
  await assert.rejects(assertSafeProviderUrl('file:///etc/passwd', opts), /http or https/);
  await assert.rejects(assertSafeProviderUrl('https://user:pw@example.com', opts), /credentials/);
  await assert.rejects(assertSafeProviderUrl('http://169.254.169.254/latest', opts), /private/);
  await assert.rejects(assertSafeProviderUrl('http://[::1]:8080', opts), /private/);
  await assert.doesNotReject(assertSafeProviderUrl('http://127.0.0.1:11434/v1', { allowPrivate: true }));
});

test('crypto: password hashing round-trip', async () => {
  const hash = await hashPassword('a long password');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('a long password', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('crypto: encryption round-trip, random IV, tamper detection', () => {
  const a = encrypt('sk-secret');
  assert.notEqual(a, encrypt('sk-secret'));
  assert.equal(decrypt(a), 'sk-secret');
  const [iv, tag, data] = a.split(':');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => decrypt([iv, tag, flipped.toString('base64')].join(':')));
});
