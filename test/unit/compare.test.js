import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCases, evaluateGate } from '../../src/modules/runs/compare.js';

const c = (id, status, output = 'x') => ({ testCaseId: id, caseName: id, status, output });

test('classifies every kind of change between two runs', () => {
  const base = [c('a', 'PASSED'), c('b', 'FAILED'), c('c', 'FAILED'), c('d', 'PASSED'), c('gone', 'PASSED')];
  const head = [
    c('a', 'FAILED'),
    c('b', 'PASSED'),
    c('c', 'ERROR'),
    c('d', 'PASSED', 'y'),
    c('new', 'PASSED'),
  ];
  const { summary, items } = compareCases(base, head);

  assert.equal(summary.regressed, 1);
  assert.equal(summary.fixed, 1);
  assert.equal(summary.still_failing, 1);
  assert.equal(summary.still_passing, 1);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(items[0].category, 'regressed', 'regressions are listed first');
  assert.equal(items.find((i) => i.key === 'd').outputChanged, true);
});

test('cases whose test case was deleted are matched by name', () => {
  const { summary } = compareCases(
    [{ testCaseId: null, caseName: 'old', status: 'PASSED', output: '' }],
    [{ testCaseId: null, caseName: 'old', status: 'FAILED', output: '' }],
  );
  assert.equal(summary.regressed, 1);
});

test('unfinished cases are reported as pending, not as regressions', () => {
  const { summary } = compareCases([c('a', 'PASSED')], [c('a', 'RUNNING')]);
  assert.equal(summary.pending, 1);
  assert.equal(summary.regressed, 0);
});

const run = (overrides) => ({ status: 'COMPLETED', failedCases: 0, erroredCases: 0, ...overrides });

test('gate: pending while running, failed when cancelled', () => {
  assert.equal(evaluateGate(run({ status: 'RUNNING' })).status, 'pending');
  assert.equal(evaluateGate(run({ status: 'CANCELLED' })).status, 'failed');
});

test('gate without baseline: any failure fails', () => {
  assert.equal(evaluateGate(run({})).status, 'passed');
  assert.equal(evaluateGate(run({ failedCases: 1 })).status, 'failed');
});

test('gate with baseline: known failures are tolerated, regressions are not', () => {
  const noRegressions = { summary: { regressed: 0 } };
  assert.equal(evaluateGate(run({ failedCases: 2 }), noRegressions).status, 'passed');
  const result = evaluateGate(run({ failedCases: 2 }), { summary: { regressed: 1 } });
  assert.equal(result.status, 'failed');
  assert.match(result.reasons[0], /regressed/);
});

test('gate: errors always fail, because an unverified case is not a pass', () => {
  assert.equal(evaluateGate(run({ erroredCases: 1 }), { summary: { regressed: 0 } }).status, 'failed');
});
