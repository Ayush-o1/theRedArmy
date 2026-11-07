// Pure functions for comparing two runs and deciding the CI gate. They take
// plain data, not database handles, so they are unit-tested without Postgres.

const PASS = 'PASSED';
const FAILING = new Set(['FAILED', 'ERROR']);
const TERMINAL = new Set(['PASSED', 'FAILED', 'ERROR', 'CANCELLED']);

// Match cases by their test-case id. Fall back to the name when the test case
// was deleted after the run (its run_case row keeps the name).
const caseKey = (c) => c.testCaseId ?? `name:${c.caseName}`;

function classify(base, head) {
  if (!base) return 'added';
  if (!head) return 'removed';
  if (!TERMINAL.has(base.status) || !TERMINAL.has(head.status)) return 'pending';
  if (base.status === PASS && FAILING.has(head.status)) return 'regressed';
  if (FAILING.has(base.status) && head.status === PASS) return 'fixed';
  if (FAILING.has(base.status) && FAILING.has(head.status)) return 'still_failing';
  if (base.status === PASS && head.status === PASS) return 'still_passing';
  return 'other'; // e.g. one side cancelled
}

const side = (c) =>
  c && {
    status: c.status,
    output: c.output,
    error: c.error,
    assertionResults: c.assertionResults,
    latencyMs: c.latencyMs,
    cacheHit: c.cacheHit,
  };

export function compareCases(baseCases, headCases) {
  const base = new Map(baseCases.map((c) => [caseKey(c), c]));
  const head = new Map(headCases.map((c) => [caseKey(c), c]));
  const keys = [...new Set([...base.keys(), ...head.keys()])];

  const items = keys.map((key) => {
    const b = base.get(key);
    const h = head.get(key);
    return {
      key,
      caseName: (h ?? b).caseName,
      category: classify(b, h),
      outputChanged: Boolean(b && h && b.output !== h.output),
      base: side(b),
      head: side(h),
    };
  });

  // Show the most important rows first.
  const order = [
    'regressed',
    'fixed',
    'still_failing',
    'added',
    'removed',
    'pending',
    'other',
    'still_passing',
  ];
  items.sort(
    (x, y) => order.indexOf(x.category) - order.indexOf(y.category) || x.caseName.localeCompare(y.caseName),
  );

  const summary = Object.fromEntries(order.map((c) => [c, 0]));
  for (const item of items) summary[item.category] += 1;
  summary.outputChanged = items.filter((i) => i.outputChanged).length;
  return { summary, items };
}

/**
 * The CI pass/fail decision.
 *
 * With a baseline, only *regressions* fail the gate. A case that was already
 * failing does not block a merge, so teams can add a test for a known bug
 * before it is fixed. Without a baseline, every case must pass.
 * Errors (the model never answered) always fail: an unverified case is not a pass.
 */
export function evaluateGate(run, comparison) {
  if (run.status === 'QUEUED' || run.status === 'RUNNING') {
    return { status: 'pending', reasons: ['Run has not finished'] };
  }
  if (run.status === 'CANCELLED') return { status: 'failed', reasons: ['Run was cancelled'] };

  const reasons = [];
  if (run.erroredCases > 0) reasons.push(`${run.erroredCases} case(s) errored`);
  if (comparison) {
    if (comparison.summary.regressed > 0) {
      reasons.push(`${comparison.summary.regressed} case(s) regressed against the baseline`);
    }
  } else if (run.failedCases > 0) {
    reasons.push(`${run.failedCases} case(s) failed`);
  }
  return reasons.length ? { status: 'failed', reasons } : { status: 'passed', reasons: [] };
}
