import { get, post } from '../api.js';
import { formValues, h, mount } from '../dom.js';
import { appShell } from '../layout.js';
import { asyncForm, emptyState, field, loading, pageHead, statusBadge } from '../components.js';
import { timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { loadInto } from './common.js';

function createForm() {
  return asyncForm({
    submitLabel: 'Create project',
    children: h(
      'div',
      { class: 'row' },
      field(
        'Project name',
        h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Support assistant' }),
      ),
      field('Description', h('input', { name: 'description', maxlength: 500, placeholder: 'Optional' })),
    ),
    onSubmit: async (form) => {
      const { project } = await post('/projects', formValues(form));
      navigate(`/p/${project.id}/runs`);
    },
  });
}

function projectTable(projects) {
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
          h('th', null, 'Project'),
          h('th', { class: 'num' }, 'Prompts'),
          h('th', { class: 'num' }, 'Suites'),
          h('th', { class: 'num' }, 'Runs'),
          h('th', null, 'Last run'),
        ),
      ),
      h(
        'tbody',
        null,
        projects.map((p) =>
          h(
            'tr',
            { class: 'clickable', onclick: () => navigate(`/p/${p.id}/runs`) },
            h(
              'td',
              null,
              h('a', { href: `#/p/${p.id}/runs` }, p.name),
              p.description ? h('div', { class: 'muted small' }, p.description) : null,
            ),
            h('td', { class: 'num' }, p.counts.prompts),
            h('td', { class: 'num' }, p.counts.suites),
            h('td', { class: 'num' }, p.counts.runs),
            h(
              'td',
              null,
              p.lastRun
                ? [
                    statusBadge(p.lastRun.status),
                    ' ',
                    h('span', { class: 'muted small' }, timeAgo(p.lastRun.createdAt)),
                  ]
                : h('span', { class: 'faint' }, 'Never'),
            ),
          ),
        ),
      ),
    ),
  );
}

export async function projectsView() {
  const main = appShell();
  mount(main, loading());
  await loadInto(
    main,
    () => get('/projects'),
    ({ projects }) => [
      pageHead(
        'Projects',
        'A project groups the prompts, test suites and providers for one product or feature.',
      ),
      projects.length
        ? h('section', { class: 'block' }, projectTable(projects))
        : emptyState('No projects yet', 'Create your first project below to start testing prompts.'),
      h(
        'section',
        { class: 'block' },
        h('header', null, h('h2', null, 'New project')),
        h('div', { class: 'panel panel-body' }, createForm()),
      ),
    ],
  );
}
