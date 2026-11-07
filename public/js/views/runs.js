import { get, post } from '../api.js';
import { h, mount } from '../dom.js';
import { asyncForm, emptyState, field, pageHead, runOutcomeBadge } from '../components.js';
import { shortId, timeAgo, usd } from '../format.js';
import { navigate } from '../router.js';
import { loadInto, projectPage } from './common.js';

export function runLabel(run) {
  return `${run.promptVersion.prompt.name} v${run.promptVersion.version}`;
}

function runsTable(projectId, runs) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Run'),
          h('th', null, 'Prompt'),
          h('th', { class: 'hide-sm' }, 'Suite'),
          h('th', { class: 'hide-sm' }, 'Provider'),
          h('th', null, 'Result'),
          h('th', { class: 'num hide-sm' }, 'Cost'),
          h('th', null, 'Created'),
        ),
      ),
      h(
        'tbody',
        null,
        runs.map((run) =>
          h(
            'tr',
            { class: 'clickable', onclick: () => navigate(`/p/${projectId}/runs/${run.id}`) },
            h(
              'td',
              null,
              h('a', { href: `#/p/${projectId}/runs/${run.id}`, class: 'mono' }, shortId(run.id)),
            ),
            h('td', null, runLabel(run)),
            h('td', { class: 'hide-sm' }, run.suite.name),
            h('td', { class: 'hide-sm' }, run.providerConfig.name),
            h(
              'td',
              null,
              runOutcomeBadge(run),
              run.status === 'COMPLETED' || run.status === 'CANCELLED'
                ? h('span', { class: 'muted small' }, ` ${run.passedCases}/${run.totalCases} passed`)
                : null,
            ),
            h(
              'td',
              { class: 'num hide-sm' },
              run.cachedCases === run.totalCases && run.totalCases > 0
                ? h('span', { title: 'Every case was served from cache' }, '$0 · cached')
                : usd(run.costUsd),
            ),
            h('td', { class: 'nowrap muted' }, timeAgo(run.createdAt)),
          ),
        ),
      ),
    ),
  );
}

/** The "start a run" form. Picks sensible defaults so one click is enough. */
function newRunForm(projectId, { prompts, suites, providers, completedRuns }) {
  const promptSelect = h(
    'select',
    { name: 'prompt', required: true },
    prompts.map((p) => h('option', { value: p.id }, p.name)),
  );
  const versionSelect = h('select', { name: 'promptVersionId', required: true });
  const suiteSelect = h(
    'select',
    { name: 'suiteId', required: true },
    suites.map((s) => h('option', { value: s.id }, `${s.name} (${s.caseCount} cases)`)),
  );
  const providerSelect = h(
    'select',
    { name: 'providerConfigId', required: true },
    providers.map((p) => h('option', { value: p.id }, `${p.name} · ${p.model}`)),
  );
  const baselineSelect = h(
    'select',
    { name: 'baselineRunId' },
    h('option', { value: '' }, 'None (every case must pass)'),
    completedRuns.map((r) =>
      h(
        'option',
        { value: r.id },
        `${shortId(r.id)} · ${runLabel(r)} · ${r.suite.name} · ${r.passedCases}/${r.totalCases} passed`,
      ),
    ),
  );
  const cache = h('input', { type: 'checkbox', name: 'useCache', checked: true });

  async function loadVersions() {
    versionSelect.replaceChildren(h('option', null, 'Loading…'));
    const { prompt } = await get(`/projects/${projectId}/prompts/${promptSelect.value}`);
    versionSelect.replaceChildren(
      ...prompt.versions.map((v) =>
        h('option', { value: v.id }, `v${v.version}${v.note ? ` · ${v.note}` : ''}`),
      ),
    );
  }
  promptSelect.addEventListener('change', loadVersions);
  loadVersions();

  return asyncForm({
    submitLabel: 'Start run',
    children: [
      h(
        'div',
        { class: 'row' },
        field('Prompt', promptSelect),
        field('Version', versionSelect),
        field('Test suite', suiteSelect),
        field('Provider', providerSelect),
      ),
      field(
        'Baseline run',
        baselineSelect,
        'With a baseline, only cases that passed before and fail now count against the gate.',
      ),
      h(
        'label',
        { class: 'check' },
        cache,
        'Reuse cached responses for identical prompts (only applies at temperature 0)',
      ),
    ],
    onSubmit: async () => {
      const { run } = await post(`/projects/${projectId}/runs`, {
        promptVersionId: versionSelect.value,
        suiteId: suiteSelect.value,
        providerConfigId: providerSelect.value,
        baselineRunId: baselineSelect.value || null,
        useCache: cache.checked,
      });
      navigate(`/p/${projectId}/runs/${run.id}`);
    },
  });
}

function setupChecklist(projectId, { prompts, suites, providers }) {
  const missing = [
    !providers.length &&
      h(
        'li',
        null,
        h('a', { href: `#/p/${projectId}/providers` }, 'Add a provider'),
        ' (the simulated one needs no API key)',
      ),
    !prompts.length && h('li', null, h('a', { href: `#/p/${projectId}/prompts` }, 'Create a prompt')),
    !suites.length && h('li', null, h('a', { href: `#/p/${projectId}/suites` }, 'Create a test suite')),
  ].filter(Boolean);
  return emptyState('Almost ready to run', h('ol', { class: 'muted' }, missing));
}

export async function runsView({ projectId }) {
  const page = await projectPage(projectId, 'runs');
  if (!page) return;
  const base = `/projects/${projectId}`;
  let cursor = null;

  await loadInto(
    page.main,
    async () => {
      const [runs, prompts, suites, providers, completed] = await Promise.all([
        get(`${base}/runs?limit=25`),
        get(`${base}/prompts`),
        get(`${base}/suites`),
        get(`${base}/providers`),
        get(`${base}/runs?limit=50&status=COMPLETED`),
      ]);
      return {
        runs,
        prompts: prompts.prompts,
        suites: suites.suites.filter((s) => s.caseCount > 0),
        providers: providers.providers,
        completedRuns: completed.runs,
      };
    },
    (data) => {
      cursor = data.runs.nextCursor;
      const tableSlot = h('div');
      const allRuns = [...data.runs.runs];
      const moreButton = h('button', { type: 'button' }, 'Load older runs');
      const renderTable = () => {
        mount(tableSlot, runsTable(projectId, allRuns));
        moreButton.hidden = !cursor;
      };
      moreButton.addEventListener('click', async () => {
        moreButton.disabled = true;
        const next = await get(`${base}/runs?limit=25&cursor=${cursor}`);
        allRuns.push(...next.runs);
        cursor = next.nextCursor;
        moreButton.disabled = false;
        renderTable();
      });

      const ready = data.prompts.length && data.suites.length && data.providers.length;
      if (allRuns.length) renderTable();

      return [
        pageHead(
          page.project.name,
          page.project.description || 'Run prompt versions against your test suites.',
        ),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'Start a run')),
          ready
            ? h('div', { class: 'panel panel-body' }, newRunForm(projectId, data))
            : setupChecklist(projectId, data),
        ),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'Recent runs')),
          allRuns.length
            ? [tableSlot, h('div', { class: 'actions', style: { marginTop: '10px' } }, moreButton)]
            : emptyState('No runs yet', 'Runs you start will appear here.'),
        ),
      ];
    },
  );
}
