import { del, get, patch, post } from '../api.js';
import { formValues, h, mount } from '../dom.js';
import { asyncForm, confirmAction, emptyState, field, pageHead, statusBadge, toast } from '../components.js';
import { timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { loadInto, projectPage } from './common.js';

function ciExample() {
  const origin = location.origin;
  return `# 1. Start a run of the latest prompt version, compared with the previous version.
curl -s -X POST ${origin}/api/v1/runs \\
  -H "Authorization: Bearer $THEREDARMY_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $GITHUB_SHA" \\
  -d '{"prompt":"<prompt name>","suite":"<suite name>","provider":"<provider name>","baseline":"previous"}'

# 2. Poll until run.gate.status is "passed" or "failed".
curl -s ${origin}/api/v1/runs/<run id> -H "Authorization: Bearer $THEREDARMY_KEY"`;
}

export async function settingsView({ projectId }) {
  const page = await projectPage(projectId, 'settings');
  if (!page) return;
  const reload = () => settingsView({ projectId });
  const base = `/projects/${projectId}`;

  await loadInto(
    page.main,
    () => get(`${base}/api-keys`),
    ({ apiKeys }) => {
      const newKeySlot = h('div');
      const keyForm = asyncForm({
        submitLabel: 'Create key',
        children: field(
          'Key name',
          h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'github-actions' }),
        ),
        onSubmit: async (form) => {
          const { key } = await post(`${base}/api-keys`, formValues(form));
          const copy = h(
            'button',
            {
              type: 'button',
              onclick: async () => {
                await navigator.clipboard.writeText(key);
                toast('Copied');
              },
            },
            'Copy',
          );
          mount(
            newKeySlot,
            h(
              'p',
              { class: 'small' },
              h('strong', null, 'Copy this key now. '),
              'Only a hash is stored, so it cannot be shown again.',
            ),
            h('div', { class: 'secret' }, h('code', null, key), copy),
          );
          form.reset();
          get(`${base}/api-keys`).then(({ apiKeys: fresh }) => mount(keysSlot, keysTable(fresh)));
        },
      });

      const keysTable = (keys) =>
        keys.length
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
                    h('th', null, 'Name'),
                    h('th', null, 'Key'),
                    h('th', null, 'Created'),
                    h('th', null, 'Last used'),
                    h('th', null, 'Status'),
                    h('th', null, ''),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  keys.map((k) =>
                    h(
                      'tr',
                      null,
                      h('td', null, k.name),
                      h('td', { class: 'mono' }, `${k.prefix}…`),
                      h('td', { class: 'muted' }, timeAgo(k.createdAt)),
                      h('td', { class: 'muted' }, k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'Never'),
                      h(
                        'td',
                        null,
                        k.revokedAt ? statusBadge('CANCELLED') : h('span', { class: 'badge pass' }, 'Active'),
                      ),
                      h(
                        'td',
                        null,
                        k.revokedAt
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                class: 'link',
                                onclick: async () => {
                                  if (
                                    !confirmAction(
                                      `Revoke key "${k.name}"? CI jobs using it will start failing.`,
                                    )
                                  )
                                    return;
                                  await del(`${base}/api-keys/${k.id}`);
                                  reload();
                                },
                              },
                              'Revoke',
                            ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : emptyState('No API keys', 'Create one for your CI pipeline.');
      const keysSlot = h('div', null, keysTable(apiKeys));

      return [
        pageHead('Settings & CI'),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'API keys')),
          keysSlot,
          h('div', { class: 'panel panel-body', style: { marginTop: '12px' } }, newKeySlot, keyForm),
        ),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'Using theRedArmy from CI')),
          h(
            'p',
            { class: 'muted' },
            'Start a run when a prompt changes, then fail the build if the gate fails. Reusing the commit SHA as the Idempotency-Key means a retried CI step does not start a second run.',
          ),
          h('pre', null, ciExample()),
        ),
        h(
          'section',
          { class: 'block' },
          h('header', null, h('h2', null, 'Project')),
          h(
            'div',
            { class: 'panel panel-body' },
            asyncForm({
              submitLabel: 'Save',
              children: h(
                'div',
                { class: 'row' },
                field(
                  'Name',
                  h('input', { name: 'name', required: true, maxlength: 80, value: page.project.name }),
                ),
                field(
                  'Description',
                  h('input', { name: 'description', maxlength: 500, value: page.project.description }),
                ),
              ),
              onSubmit: async (form) => {
                await patch(base, formValues(form));
                toast('Project saved');
                reload();
              },
            }),
          ),
          h(
            'div',
            { style: { marginTop: '12px' } },
            h(
              'button',
              {
                type: 'button',
                class: 'danger',
                onclick: async () => {
                  if (
                    !confirmAction(
                      `Delete "${page.project.name}" and all its prompts, suites, runs and keys? This cannot be undone.`,
                    )
                  )
                    return;
                  await del(base);
                  toast('Project deleted');
                  navigate('/');
                },
              },
              'Delete project',
            ),
          ),
        ),
      ];
    },
  );
}
