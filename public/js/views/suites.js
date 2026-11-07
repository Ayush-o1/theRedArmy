import { del, get, post } from '../api.js';
import { formValues, h, mount } from '../dom.js';
import { asyncForm, confirmAction, emptyState, field, pageHead, toast } from '../components.js';
import { navigate } from '../router.js';
import { loadInto, projectPage } from './common.js';

// The assertion types the server supports, with the inputs each one needs.
const ASSERTION_TYPES = {
  contains: { label: 'contains', inputs: ['value'] },
  not_contains: { label: 'does not contain', inputs: ['value'] },
  equals: { label: 'equals', inputs: ['value'] },
  regex: { label: 'matches regex', inputs: ['pattern', 'flags'] },
  max_length: { label: 'length at most', inputs: ['number'] },
  min_length: { label: 'length at least', inputs: ['number'] },
  is_json: { label: 'is valid JSON', inputs: [] },
  json_field_equals: { label: 'JSON field equals', inputs: ['path', 'value'] },
  latency_under_ms: { label: 'latency under (ms)', inputs: ['number'] },
};

export function describeAssertion(a) {
  const label = ASSERTION_TYPES[a.type]?.label ?? a.type;
  if (a.type === 'regex') return `${label} /${a.pattern}/${a.flags ?? ''}`;
  if (a.type === 'json_field_equals') return `${a.path} = ${JSON.stringify(a.value)}`;
  if (a.type === 'is_json') return label;
  return `${label} ${typeof a.value === 'string' ? `"${a.value}"` : a.value}`;
}

// json_field_equals compares typed values: "42" and 42 are different.
function parseLiteral(text) {
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(text.trim())) return JSON.parse(text.trim());
  return text;
}

/** A small row-based editor that produces the assertions array. */
function assertionEditor() {
  const list = h('div', { class: 'stack', style: { display: 'grid', gap: '8px' } });
  const rows = [];

  function addRow() {
    const type = h(
      'select',
      { 'aria-label': 'Check type' },
      Object.entries(ASSERTION_TYPES).map(([k, t]) => h('option', { value: k }, t.label)),
    );
    const inputs = h('div', { class: 'row' });
    const row = { type, inputs, el: null };
    const renderInputs = () => {
      const spec = ASSERTION_TYPES[type.value].inputs;
      mount(
        inputs,
        spec.map((name) =>
          h('input', {
            name,
            'aria-label': name,
            type: name === 'number' ? 'number' : 'text',
            placeholder: {
              value: 'expected text',
              pattern: '^\\d+$',
              flags: 'flags (i, m, s)',
              path: 'field.path',
              number: '100',
            }[name],
          }),
        ),
      );
    };
    type.addEventListener('change', renderInputs);
    renderInputs();
    row.el = h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, 200px) 1fr auto',
          gap: '8px',
          alignItems: 'start',
        },
      },
      type,
      inputs,
      h(
        'button',
        {
          type: 'button',
          'aria-label': 'Remove check',
          onclick: () => {
            rows.splice(rows.indexOf(row), 1);
            row.el.remove();
          },
        },
        'Remove',
      ),
    );
    rows.push(row);
    list.append(row.el);
  }

  return {
    el: h(
      'div',
      { class: 'field' },
      h('label', null, 'Checks on the output'),
      list,
      h('div', null, h('button', { type: 'button', class: 'link', onclick: addRow }, '+ Add check')),
    ),
    read() {
      return rows.map(({ type, inputs }) => {
        const v = Object.fromEntries([...inputs.querySelectorAll('input')].map((i) => [i.name, i.value]));
        switch (type.value) {
          case 'regex':
            return { type: 'regex', pattern: v.pattern, flags: v.flags };
          case 'json_field_equals':
            return { type: type.value, path: v.path, value: parseLiteral(v.value) };
          case 'is_json':
            return { type: 'is_json' };
          case 'max_length':
          case 'min_length':
          case 'latency_under_ms':
            return { type: type.value, value: Number(v.number) };
          default:
            return { type: type.value, value: v.value };
        }
      });
    },
    reset() {
      rows.splice(0).forEach((r) => r.el.remove());
      addRow();
    },
    addRow,
  };
}

function parseVariables(text) {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new Error('Variables must be a JSON object, for example {"ticket": "Where is my order?"}');
}

export async function suitesView({ projectId }) {
  const page = await projectPage(projectId, 'suites');
  if (!page) return;
  await loadInto(
    page.main,
    () => get(`/projects/${projectId}/suites`),
    ({ suites }) => [
      pageHead(
        'Test suites',
        'A suite is a set of test cases: input variables for the prompt, plus checks on the output.',
      ),
      suites.length
        ? h(
            'div',
            { class: 'table-wrap block' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, h('th', null, 'Suite'), h('th', { class: 'num' }, 'Cases'))),
              h(
                'tbody',
                null,
                suites.map((s) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => navigate(`/p/${projectId}/suites/${s.id}`) },
                    h(
                      'td',
                      null,
                      h('a', { href: `#/p/${projectId}/suites/${s.id}` }, s.name),
                      s.description ? h('div', { class: 'muted small' }, s.description) : null,
                    ),
                    h('td', { class: 'num' }, s.caseCount),
                  ),
                ),
              ),
            ),
          )
        : emptyState('No test suites yet', 'Create one, then add test cases to it.'),
      h(
        'section',
        { class: 'block', style: { marginTop: '24px' } },
        h('header', null, h('h2', null, 'New suite')),
        h(
          'div',
          { class: 'panel panel-body' },
          asyncForm({
            submitLabel: 'Create suite',
            children: h(
              'div',
              { class: 'row' },
              field(
                'Name',
                h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'core-tickets' }),
              ),
              field('Description', h('input', { name: 'description', maxlength: 500 })),
            ),
            onSubmit: async (form) => {
              const { suite } = await post(`/projects/${projectId}/suites`, formValues(form));
              navigate(`/p/${projectId}/suites/${suite.id}`);
            },
          }),
        ),
      ),
    ],
  );
}

export async function suiteDetailView({ projectId, suiteId }) {
  const page = await projectPage(projectId, 'suites');
  if (!page) return;
  const base = `/projects/${projectId}/suites/${suiteId}`;
  const reload = () => suiteDetailView({ projectId, suiteId });

  await loadInto(
    page.main,
    () => get(base),
    ({ suite }) => {
      const editor = assertionEditor();
      editor.addRow();

      const casesTable = suite.cases.length
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
                  h('th', null, 'Variables'),
                  h('th', null, 'Checks'),
                  h('th', null, h('span', { class: 'sr-only' }, 'Actions')),
                ),
              ),
              h(
                'tbody',
                null,
                suite.cases.map((c) =>
                  h(
                    'tr',
                    null,
                    h('td', null, c.name),
                    h('td', null, h('code', { class: 'small' }, JSON.stringify(c.variables))),
                    h(
                      'td',
                      null,
                      c.assertions.length
                        ? h(
                            'ul',
                            { class: 'assertions' },
                            c.assertions.map((a) => h('li', null, describeAssertion(a))),
                          )
                        : h('span', { class: 'faint' }, 'none'),
                    ),
                    h(
                      'td',
                      { class: 'num' },
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'link',
                          onclick: async () => {
                            if (!confirmAction(`Delete case "${c.name}"? Past runs keep their copy.`)) return;
                            try {
                              await del(`${base}/cases/${c.id}`);
                              reload();
                            } catch (err) {
                              toast(err.message, { error: true });
                            }
                          },
                        },
                        'Delete',
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : emptyState('No test cases yet', 'Add one with the form below, or paste several as JSON.');

      return [
        pageHead(
          suite.name,
          suite.description || `${suite.cases.length} case(s)`,
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: async () => {
                if (!confirmAction(`Delete suite "${suite.name}"?`)) return;
                try {
                  await del(base);
                  navigate(`/p/${projectId}/suites`);
                } catch (err) {
                  toast(err.message, { error: true });
                }
              },
            },
            'Delete suite',
          ),
        ),
        h('section', { class: 'block' }, casesTable),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'Add a test case')),
          h(
            'div',
            { class: 'panel panel-body' },
            asyncForm({
              submitLabel: 'Add case',
              children: [
                h(
                  'div',
                  { class: 'row' },
                  field(
                    'Case name',
                    h('input', {
                      name: 'name',
                      required: true,
                      maxlength: 120,
                      placeholder: 'refund-request',
                    }),
                  ),
                ),
                field(
                  'Variables (JSON)',
                  h('textarea', {
                    name: 'variables',
                    rows: 3,
                    placeholder: '{"ticket": "I was charged twice"}',
                  }),
                  'Values for the {{placeholders}} in your prompt.',
                ),
                editor.el,
              ],
              onSubmit: async (form) => {
                const v = formValues(form);
                await post(`${base}/cases`, {
                  cases: [
                    { name: v.name, variables: parseVariables(v.variables), assertions: editor.read() },
                  ],
                });
                toast('Case added');
                reload();
              },
            }),
          ),
        ),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'Bulk import')),
          h(
            'div',
            { class: 'panel panel-body' },
            asyncForm({
              submitLabel: 'Import cases',
              children: field(
                'Cases (JSON array)',
                h('textarea', {
                  name: 'json',
                  rows: 6,
                  placeholder:
                    '[{"name": "late-delivery", "variables": {"ticket": "Parcel is late"}, "assertions": [{"type": "contains", "value": "shipping"}]}]',
                }),
                'All cases are imported, or none are if any is invalid.',
              ),
              onSubmit: async (form) => {
                let cases;
                try {
                  cases = JSON.parse(formValues(form).json);
                } catch {
                  throw new Error('That is not valid JSON.');
                }
                const { cases: created } = await post(`${base}/cases`, {
                  cases: Array.isArray(cases) ? cases : [cases],
                });
                toast(`Imported ${created.length} case(s)`);
                reload();
              },
            }),
          ),
        ),
      ];
    },
  );
}
