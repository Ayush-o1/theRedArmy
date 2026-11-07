import { del, get, post } from '../api.js';
import { formValues, h } from '../dom.js';
import { asyncForm, confirmAction, emptyState, field, pageHead, toast } from '../components.js';
import { dateTime, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { loadInto, projectPage } from './common.js';

// Mirrors the server's placeholder pattern so the UI can show variables live.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g;
const variablesOf = (template) => [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];

function variableChips(names) {
  return names.length
    ? names.map((n) => [h('code', { class: 'tag' }, n), ' '])
    : h('span', { class: 'faint' }, 'none');
}

/** Fields for one prompt version, optionally pre-filled from an existing version. */
function versionFields(from = {}) {
  const template = h('textarea', {
    name: 'template',
    required: true,
    rows: 8,
    value: from.template ?? '',
    placeholder: 'Classify this support ticket: {{ticket}}',
  });
  const detected = h('span', { class: 'hint' });
  const updateDetected = () => {
    detected.replaceChildren('Variables: ', ...[variableChips(variablesOf(template.value))].flat(2));
  };
  template.addEventListener('input', updateDetected);
  updateDetected();

  return [
    field(
      'System prompt',
      h('textarea', { name: 'systemPrompt', rows: 3, value: from.systemPrompt ?? '' }),
      'Optional. Sent as the system message.',
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'tpl' }, 'Prompt template'),
      Object.assign(template, { id: 'tpl' }),
      detected,
    ),
    h(
      'div',
      { class: 'row' },
      field(
        'Temperature',
        h('input', {
          name: 'temperature',
          type: 'number',
          min: 0,
          max: 2,
          step: 0.1,
          value: String(from.temperature ?? 0),
        }),
        '0 = deterministic and cacheable',
      ),
      field(
        'Max tokens',
        h('input', {
          name: 'maxTokens',
          type: 'number',
          min: 1,
          max: 32000,
          value: String(from.maxTokens ?? 512),
        }),
      ),
      field('Change note', h('input', { name: 'note', maxlength: 500, placeholder: 'What changed and why' })),
    ),
  ];
}

function versionPayload(values) {
  return {
    systemPrompt: values.systemPrompt,
    template: values.template,
    temperature: Number(values.temperature),
    maxTokens: Number(values.maxTokens),
    note: values.note,
  };
}

export async function promptsView({ projectId }) {
  const page = await projectPage(projectId, 'prompts');
  if (!page) return;
  await loadInto(
    page.main,
    () => get(`/projects/${projectId}/prompts`),
    ({ prompts }) => [
      pageHead(
        'Prompts',
        'Each save creates a new immutable version, so every run records exactly which text it used.',
      ),
      prompts.length
        ? h(
            'section',
            { class: 'block' },
            h(
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
                    h('th', null, 'Prompt'),
                    h('th', null, 'Latest'),
                    h('th', null, 'Variables'),
                    h('th', null, 'Updated'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  prompts.map((p) =>
                    h(
                      'tr',
                      { class: 'clickable', onclick: () => navigate(`/p/${projectId}/prompts/${p.id}`) },
                      h(
                        'td',
                        null,
                        h('a', { href: `#/p/${projectId}/prompts/${p.id}` }, p.name),
                        p.description ? h('div', { class: 'muted small' }, p.description) : null,
                      ),
                      h('td', null, `v${p.latestVersion}`),
                      h('td', null, variableChips(p.latest?.variables ?? [])),
                      h('td', { class: 'muted nowrap' }, timeAgo(p.latest?.createdAt)),
                    ),
                  ),
                ),
              ),
            ),
          )
        : emptyState(
            'No prompts yet',
            'Create one below. Use {{variable}} placeholders for the parts each test case fills in.',
          ),
      h(
        'section',
        { class: 'block' },
        h('header', null, h('h2', null, 'New prompt')),
        h(
          'div',
          { class: 'panel panel-body' },
          asyncForm({
            submitLabel: 'Create prompt',
            children: [
              h(
                'div',
                { class: 'row' },
                field(
                  'Name',
                  h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'ticket-triage' }),
                  'Used by the CI API, so keep it short.',
                ),
                field('Description', h('input', { name: 'description', maxlength: 500 })),
              ),
              versionFields(),
            ],
            onSubmit: async (form) => {
              const v = formValues(form);
              const { prompt } = await post(`/projects/${projectId}/prompts`, {
                name: v.name,
                description: v.description,
                version: versionPayload(v),
              });
              navigate(`/p/${projectId}/prompts/${prompt.id}`);
            },
          }),
        ),
      ),
    ],
  );
}

function versionDetails(v, open) {
  return h(
    'details',
    { class: 'case', open },
    h(
      'summary',
      null,
      h('strong', null, `v${v.version}`),
      h('span', null, v.note || h('span', { class: 'faint' }, 'No note')),
      h('span', { class: 'muted small' }, dateTime(v.createdAt)),
    ),
    h(
      'div',
      { class: 'case-body' },
      v.systemPrompt ? h('div', null, h('h3', null, 'System prompt'), h('pre', null, v.systemPrompt)) : null,
      h('div', null, h('h3', null, 'Template'), h('pre', null, v.template)),
      h(
        'p',
        { class: 'muted small' },
        `Temperature ${v.temperature} · max ${v.maxTokens} tokens · variables: `,
        variableChips(v.variables),
      ),
    ),
  );
}

export async function promptDetailView({ projectId, promptId }) {
  const page = await projectPage(projectId, 'prompts');
  if (!page) return;
  await loadInto(
    page.main,
    () => get(`/projects/${projectId}/prompts/${promptId}`),
    ({ prompt }) => [
      pageHead(
        prompt.name,
        prompt.description || `${prompt.versions.length} version(s)`,
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: async () => {
              if (!confirmAction(`Delete prompt "${prompt.name}" and all its versions?`)) return;
              try {
                await del(`/projects/${projectId}/prompts/${promptId}`);
                toast('Prompt deleted');
                navigate(`/p/${projectId}/prompts`);
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          },
          'Delete prompt',
        ),
      ),
      h(
        'section',
        { class: 'block' },
        h('header', null, h('h2', null, `New version (v${prompt.latestVersion + 1})`)),
        h(
          'div',
          { class: 'panel panel-body' },
          asyncForm({
            submitLabel: 'Save as new version',
            children: versionFields(prompt.versions[0]),
            onSubmit: async (form) => {
              const { version } = await post(
                `/projects/${projectId}/prompts/${promptId}/versions`,
                versionPayload(formValues(form)),
              );
              toast(`Saved v${version.version}`);
              promptDetailView({ projectId, promptId });
            },
          }),
        ),
      ),
      h(
        'section',
        { class: 'block' },
        h('header', null, h('h2', null, 'Version history')),
        h(
          'div',
          { class: 'panel' },
          prompt.versions.map((v, i) => versionDetails(v, i === 0)),
        ),
      ),
    ],
  );
}
