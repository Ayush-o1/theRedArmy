import { get } from '../api.js';
import { h } from '../dom.js';
import { emptyState, pageHead, statusBadge } from '../components.js';
import { shortId } from '../format.js';
import { currentQuery } from '../router.js';
import { loadInto, projectPage } from './common.js';
import { runLabel } from './runs.js';

const CATEGORY = {
  regressed: ['Regressed', 'fail'],
  fixed: ['Fixed', 'pass'],
  still_failing: ['Still failing', 'warn'],
  added: ['New case', ''],
  removed: ['Removed case', ''],
  pending: ['Not finished', 'active'],
  other: ['Other', ''],
  still_passing: ['Still passing', 'pass'],
};

function sideCell(side) {
  if (!side) return h('td', { class: 'faint' }, 'Not in this run');
  return h(
    'td',
    null,
    statusBadge(side.status),
    side.error
      ? h('div', { class: 'small', style: { color: 'var(--fail)', marginTop: '4px' } }, side.error)
      : null,
    h('pre', { style: { marginTop: '6px' } }, side.output ?? '—'),
  );
}

export async function compareView({ projectId }) {
  const page = await projectPage(projectId, 'runs');
  if (!page) return;
  const q = currentQuery();
  const baseId = q.get('base');
  const headId = q.get('head');
  if (!baseId || !headId) {
    page.main.replaceChildren(
      emptyState(
        'Pick two runs to compare',
        'Open a run that has a baseline and choose "Compare with baseline".',
      ),
    );
    return;
  }

  await loadInto(
    page.main,
    () =>
      get(
        `/projects/${projectId}/runs/compare?base=${encodeURIComponent(baseId)}&head=${encodeURIComponent(headId)}`,
      ),
    (cmp) => {
      const runLink = (run) =>
        h('a', { href: `#/p/${projectId}/runs/${run.id}` }, `${shortId(run.id)} · ${runLabel(run)}`);
      const interesting = cmp.items.filter((i) => i.category !== 'still_passing');
      const unchanged = cmp.items.length - interesting.length;
      return [
        pageHead('Compare runs', ['Baseline ', runLink(cmp.base), ' → ', runLink(cmp.head)]),
        cmp.warnings.map((w) => h('div', { class: 'notice' }, w)),
        h(
          'div',
          { class: 'cmp-summary' },
          Object.entries(CATEGORY)
            .filter(([key]) => cmp.summary[key] > 0)
            .map(([key, [label, style]]) =>
              h('span', { class: `badge ${style}` }, `${cmp.summary[key]} ${label.toLowerCase()}`),
            ),
          h('span', { class: 'badge' }, `${cmp.summary.outputChanged} with changed output`),
        ),
        interesting.length
          ? h(
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
                    h('th', null, 'Case'),
                    h('th', null, 'Change'),
                    h('th', null, 'Baseline'),
                    h('th', null, 'This run'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  interesting.map((item) => {
                    const [label, style] = CATEGORY[item.category];
                    return h(
                      'tr',
                      null,
                      h('td', null, item.caseName),
                      h('td', null, h('span', { class: `badge ${style}` }, label)),
                      sideCell(item.base),
                      sideCell(item.head),
                    );
                  }),
                ),
              ),
            )
          : emptyState('No differences in outcome', 'Every case that passed before still passes.'),
        unchanged
          ? h(
              'p',
              { class: 'muted', style: { marginTop: '12px' } },
              `${unchanged} case(s) passed in both runs and are hidden.`,
            )
          : null,
      ];
    },
  );
}
