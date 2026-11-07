import { del, get, post } from '../api.js';
import { h, mount } from '../dom.js';
import { confirmAction, errorAlert, pageHead, progressBar, statusBadge, toast } from '../components.js';
import { dateTime, duration, number, plural, shortId, usd } from '../format.js';
import { navigate } from '../router.js';
import { projectPage } from './common.js';
import { runLabel } from './runs.js';

const POLL_MS = 1500;
const isActive = (run) => run.status === 'QUEUED' || run.status === 'RUNNING';

function gateBanner(run) {
  if (isActive(run)) return null;
  const { gate } = run;
  const title =
    gate.status === 'passed'
      ? run.baselineRunId
        ? 'Gate passed: no regressions against the baseline'
        : 'Gate passed: every case passed'
      : 'Gate failed';
  return h(
    'div',
    { class: `gate ${gate.status}`, role: 'status' },
    statusBadge(gate.status === 'passed' ? 'PASSED' : 'FAILED'),
    h(
      'div',
      null,
      h('strong', null, title),
      gate.reasons.length
        ? h(
            'ul',
            null,
            gate.reasons.map((r) => h('li', null, r)),
          )
        : null,
    ),
  );
}

function stats(run) {
  const p = run.progress;
  const done = (p.PASSED ?? 0) + (p.FAILED ?? 0) + (p.ERROR ?? 0) + (p.CANCELLED ?? 0);
  const item = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
  return [
    progressBar({
      total: run.totalCases,
      passed: p.PASSED,
      failed: p.FAILED,
      errored: p.ERROR,
      running: p.RUNNING,
    }),
    h(
      'dl',
      { class: 'stats', style: { marginTop: '12px' } },
      item('Progress', `${done}/${run.totalCases}`),
      item('Passed', number(p.PASSED ?? 0)),
      item('Failed', number(p.FAILED ?? 0)),
      item('Errors', number(p.ERROR ?? 0)),
      item('From cache', number(run.cases.filter((c) => c.cacheHit).length)),
      item('Est. cost', usd(run.cases.reduce((s, c) => s + c.costUsd, 0))),
      item('Duration', duration(run.startedAt, run.finishedAt)),
    ),
  ];
}

function assertionList(results) {
  if (!results?.length)
    return h('p', { class: 'muted small' }, 'No assertions: this case only checks that the model answered.');
  return h(
    'ul',
    { class: 'assertions' },
    results.map((r) =>
      h(
        'li',
        null,
        h('span', { class: r.passed ? 'ok' : 'no', 'aria-hidden': 'true' }, r.passed ? '✓' : '✕'),
        h('span', { class: 'sr-only' }, r.passed ? 'Passed:' : 'Failed:'),
        h('code', null, r.type),
        h('span', { class: r.passed ? 'muted' : '' }, r.passed ? '' : r.message),
      ),
    ),
  );
}

function caseRow(c, openNames) {
  const meta = [
    c.cacheHit ? h('span', { class: 'tag' }, 'cached') : null,
    c.attempts > 1
      ? h('span', { class: 'tag', title: 'Transient errors were retried' }, `${c.attempts} attempts`)
      : null,
    c.latencyMs != null ? h('span', { class: 'muted small' }, `${c.latencyMs} ms`) : null,
  ];
  const details = h(
    'details',
    { class: 'case', open: openNames.has(c.caseName) },
    h(
      'summary',
      null,
      statusBadge(c.status),
      h('span', null, c.caseName),
      h('span', { class: 'actions case-meta' }, meta),
    ),
    h(
      'div',
      { class: 'case-body' },
      c.error ? h('div', { class: 'alert' }, c.error) : null,
      c.assertionResults ? h('div', null, h('h3', null, 'Checks'), assertionList(c.assertionResults)) : null,
      h(
        'div',
        { class: 'two' },
        h('div', null, h('h3', null, 'Prompt sent'), h('pre', null, c.renderedPrompt ?? '—')),
        h('div', null, h('h3', null, 'Model output'), h('pre', null, c.output ?? '—')),
      ),
      h(
        'p',
        { class: 'muted small' },
        `Variables: ${JSON.stringify(c.variables)} · Tokens: ${c.inputTokens} in / ${c.outputTokens} out · Cost: ${usd(c.costUsd)}`,
      ),
    ),
  );
  // Remember which rows are open so polling does not collapse them.
  details.addEventListener('toggle', () => {
    if (details.open) openNames.add(c.caseName);
    else openNames.delete(c.caseName);
  });
  return details;
}

const FILTERS = [
  ['all', 'All', () => true],
  ['failing', 'Not passing', (c) => c.status === 'FAILED' || c.status === 'ERROR'],
  ['passed', 'Passed', (c) => c.status === 'PASSED'],
];

export async function runDetailView({ projectId, runId }) {
  const page = await projectPage(projectId, 'runs');
  if (!page) return;
  const { main } = page;
  const path = `/projects/${projectId}/runs/${runId}`;
  const openNames = new Set();
  let filter = 'all';
  let timer = null;
  let stopped = false;

  function render(run) {
    const fn = FILTERS.find(([key]) => key === filter)[2];
    const visible = run.cases.filter(fn);
    const actions = [];
    if (isActive(run)) {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: async () => {
              if (
                !confirmAction('Cancel this run? Cases already running will finish; the rest will not start.')
              )
                return;
              try {
                await post(`${path}/cancel`);
                refresh();
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          },
          'Cancel run',
        ),
      );
    } else {
      if (run.baselineRunId) {
        actions.push(
          h(
            'a',
            { class: 'btn', href: `#/p/${projectId}/compare?base=${run.baselineRunId}&head=${run.id}` },
            'Compare with baseline',
          ),
        );
      }
      actions.push(
        h(
          'button',
          {
            type: 'button',
            onclick: async () => {
              try {
                const { run: next } = await post(`/projects/${projectId}/runs`, {
                  promptVersionId: run.promptVersionId,
                  suiteId: run.suiteId,
                  providerConfigId: run.providerConfigId,
                  baselineRunId: run.baselineRunId,
                  useCache: run.useCache,
                });
                navigate(`/p/${projectId}/runs/${next.id}`);
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          },
          'Run again',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: async () => {
              if (!confirmAction('Delete this run and its results?')) return;
              try {
                await del(path);
                toast('Run deleted');
                navigate(`/p/${projectId}/runs`);
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          },
          'Delete',
        ),
      );
    }

    mount(
      main,
      pageHead(
        [`Run `, h('span', { class: 'mono' }, shortId(run.id)), ' ', statusBadge(run.status)],
        [
          h('a', { href: `#/p/${projectId}/prompts/${run.promptVersion.prompt.id}` }, runLabel(run)),
          ` on ${run.suite.name} via ${run.providerConfig.name} (${run.providerConfig.model}) · started ${dateTime(run.createdAt)}`,
          run.baselineRunId
            ? [
                ' · baseline ',
                h(
                  'a',
                  { href: `#/p/${projectId}/runs/${run.baselineRunId}`, class: 'mono' },
                  shortId(run.baselineRunId),
                ),
              ]
            : null,
        ],
        ...actions,
      ),
      stats(run),
      gateBanner(run),
      run.comparison && !isActive(run)
        ? h(
            'p',
            { class: 'muted' },
            `Against the baseline: ${plural(run.comparison.regressed, 'regression')}, ${run.comparison.fixed} fixed, ${run.comparison.still_failing} still failing.`,
          )
        : null,
      h(
        'section',
        { class: 'block', style: { marginTop: '20px' } },
        h(
          'header',
          null,
          h('h2', null, 'Test cases'),
          h(
            'div',
            { class: 'filters', role: 'group', 'aria-label': 'Filter cases' },
            FILTERS.map(([key, label, f]) =>
              h(
                'button',
                {
                  type: 'button',
                  'aria-pressed': String(filter === key),
                  onclick: () => {
                    filter = key;
                    render(run);
                  },
                },
                `${label} (${run.cases.filter(f).length})`,
              ),
            ),
          ),
        ),
        visible.length
          ? h(
              'div',
              { class: 'panel' },
              visible.map((c) => caseRow(c, openNames)),
            )
          : h('p', { class: 'muted' }, 'No cases match this filter.'),
      ),
    );
  }

  async function refresh() {
    try {
      const { run } = await get(path);
      if (stopped || !main.isConnected) return;
      render(run);
      if (isActive(run)) timer = setTimeout(refresh, POLL_MS);
    } catch (err) {
      if (!stopped && main.isConnected) mount(main, errorAlert(err));
    }
  }

  await refresh();
  // Cleanup when navigating away: stop polling.
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
