import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertionListSchema, evaluateAssertions } from '../../src/engine/assertions.js';

const run = (assertions, output, meta) =>
  evaluateAssertions(assertionListSchema.parse(assertions), output, meta);

test('contains is case-insensitive by default, case-sensitive on request', () => {
  assert.equal(run([{ type: 'contains', value: 'REFUND' }], 'issue a refund').passed, true);
  assert.equal(
    run([{ type: 'contains', value: 'REFUND', caseSensitive: true }], 'issue a refund').passed,
    false,
  );
});

test('not_contains fails when forbidden text appears', () => {
  const result = run([{ type: 'not_contains', value: 'sorry' }], 'Sorry, I cannot help');
  assert.equal(result.passed, false);
  assert.match(result.results[0].message, /forbidden/);
});

test('equals trims whitespace by default', () => {
  assert.equal(run([{ type: 'equals', value: 'billing' }], '  billing\n').passed, true);
  assert.equal(run([{ type: 'equals', value: 'billing', trim: false }], 'billing\n').passed, false);
});

test('regex honours flags', () => {
  assert.equal(run([{ type: 'regex', pattern: '^order #\\d+$', flags: 'i' }], 'ORDER #42').passed, true);
  assert.equal(run([{ type: 'regex', pattern: '^order #\\d+$' }], 'ORDER #42').passed, false);
});

test('invalid regex is rejected at validation time, not at run time', () => {
  assert.equal(assertionListSchema.safeParse([{ type: 'regex', pattern: '(' }]).success, false);
});

test('length checks', () => {
  assert.equal(run([{ type: 'max_length', value: 5 }], 'abcdef').passed, false);
  assert.equal(run([{ type: 'min_length', value: 3 }], 'abc').passed, true);
});

test('is_json accepts fenced JSON blocks', () => {
  assert.equal(run([{ type: 'is_json' }], '```json\n{"a":1}\n```').passed, true);
  assert.equal(run([{ type: 'is_json' }], '{a:1}').passed, false);
});

test('json_field_equals follows dot paths, including array indexes', () => {
  const output = JSON.stringify({ category: 'billing', labels: ['urgent'] });
  assert.equal(run([{ type: 'json_field_equals', path: 'category', value: 'billing' }], output).passed, true);
  assert.equal(run([{ type: 'json_field_equals', path: 'labels.0', value: 'urgent' }], output).passed, true);
  const miss = run([{ type: 'json_field_equals', path: 'category', value: 'refund' }], output);
  assert.match(miss.results[0].message, /"billing", expected "refund"/);
});

test('latency_under_ms is skipped for cache hits instead of using fake latency', () => {
  const a = [{ type: 'latency_under_ms', value: 100 }];
  assert.equal(run(a, 'x', { latencyMs: 500, cacheHit: false }).passed, false);
  assert.equal(run(a, 'x', { latencyMs: null, cacheHit: true }).passed, true);
});

test('all assertions must pass, and each reports its own result', () => {
  const result = run(
    [
      { type: 'contains', value: 'a' },
      { type: 'contains', value: 'z' },
    ],
    'abc',
  );
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.results.map((r) => r.passed),
    [true, false],
  );
});

test('unknown assertion types are rejected', () => {
  assert.equal(assertionListSchema.safeParse([{ type: 'vibes', value: 'good' }]).success, false);
});
