import { del, get, patch, post } from '../api.js';
import { formValues, h } from '../dom.js';
import { asyncForm, confirmAction, emptyState, field, pageHead, toast } from '../components.js';
import { loadInto, projectPage } from './common.js';

function providerForm(projectId, reload) {
  const kind = h(
    'select',
    { name: 'kind' },
    h('option', { value: 'SIMULATED' }, 'Simulated (free, for demos and testing the pipeline)'),
    h('option', { value: 'OPENAI_COMPATIBLE' }, 'OpenAI-compatible API (OpenAI, Groq, OpenRouter, Ollama…)'),
  );
  const real = h(
    'div',
    { class: 'row' },
    field(
      'Base URL',
      h('input', { name: 'baseUrl', placeholder: 'https://api.openai.com/v1' }),
      'The URL before /chat/completions.',
    ),
    field(
      'API key',
      h('input', { name: 'apiKey', type: 'password', autocomplete: 'off' }),
      'Encrypted at rest. Never shown again.',
    ),
  );
  const simulated = h(
    'div',
    { class: 'row' },
    field(
      'Latency (ms)',
      h('input', { name: 'latencyMs', type: 'number', min: 0, max: 10000, value: '150' }),
    ),
    field(
      'Output',
      h(
        'select',
        { name: 'mode' },
        h('option', { value: 'echo' }, 'Echo the prompt'),
        h('option', { value: 'json' }, 'JSON {"input": prompt}'),
      ),
    ),
    field(
      'Random 503 rate',
      h('input', { name: 'errorRate', type: 'number', min: 0, max: 1, step: 0.05, value: '0' }),
      '0 to 1. Exercises retries.',
    ),
    field(
      'Random 429 rate',
      h('input', { name: 'rateLimitRate', type: 'number', min: 0, max: 1, step: 0.05, value: '0' }),
    ),
  );
  const toggle = () => {
    real.hidden = kind.value !== 'OPENAI_COMPATIBLE';
    simulated.hidden = kind.value !== 'SIMULATED';
  };
  kind.addEventListener('change', toggle);
  toggle();

  return asyncForm({
    submitLabel: 'Add provider',
    children: [
      field('Type', kind),
      h(
        'div',
        { class: 'row' },
        field(
          'Name',
          h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'gpt-4o-mini' }),
          'Used by the CI API.',
        ),
        field(
          'Model',
          h('input', { name: 'model', required: true, maxlength: 120, placeholder: 'gpt-4o-mini' }),
        ),
        field(
          'Requests per minute',
          h('input', { name: 'requestsPerMinute', type: 'number', min: 1, value: '60' }),
          'Shared by all workers.',
        ),
      ),
      h(
        'div',
        { class: 'row' },
        field(
          'Input price ($ / 1M tokens)',
          h('input', { name: 'inputCostPerMTok', type: 'number', min: 0, step: 0.01, value: '0' }),
        ),
        field(
          'Output price ($ / 1M tokens)',
          h('input', { name: 'outputCostPerMTok', type: 'number', min: 0, step: 0.01, value: '0' }),
        ),
      ),
      real,
      simulated,
    ],
    onSubmit: async (form) => {
      const v = formValues(form);
      const body = {
        name: v.name,
        kind: v.kind,
        model: v.model,
        requestsPerMinute: Number(v.requestsPerMinute),
        inputCostPerMTok: Number(v.inputCostPerMTok),
        outputCostPerMTok: Number(v.outputCostPerMTok),
      };
      if (v.kind === 'OPENAI_COMPATIBLE') {
        body.baseUrl = v.baseUrl;
        if (v.apiKey) body.apiKey = v.apiKey;
      } else {
        body.settings = {
          latencyMs: Number(v.latencyMs),
          mode: v.mode,
          errorRate: Number(v.errorRate),
          rateLimitRate: Number(v.rateLimitRate),
        };
      }
      await post(`/projects/${projectId}/providers`, body);
      toast('Provider added');
      reload();
    },
  });
}

function editRow(projectId, provider, reload) {
  return h(
    'details',
    null,
    h('summary', { class: 'small' }, 'Edit'),
    asyncForm({
      submitLabel: 'Save',
      children: h(
        'div',
        { class: 'row', style: { marginTop: '8px' } },
        field(
          'Requests per minute',
          h('input', {
            name: 'requestsPerMinute',
            type: 'number',
            min: 1,
            value: String(provider.requestsPerMinute),
          }),
        ),
        provider.kind === 'OPENAI_COMPATIBLE'
          ? field(
              'Replace API key',
              h('input', {
                name: 'apiKey',
                type: 'password',
                autocomplete: 'off',
                placeholder: 'Leave empty to keep',
              }),
            )
          : null,
      ),
      onSubmit: async (form) => {
        const v = formValues(form);
        const body = { requestsPerMinute: Number(v.requestsPerMinute) };
        if (v.apiKey) body.apiKey = v.apiKey;
        await patch(`/projects/${projectId}/providers/${provider.id}`, body);
        toast('Provider updated');
        reload();
      },
    }),
  );
}

export async function providersView({ projectId }) {
  const page = await projectPage(projectId, 'providers');
  if (!page) return;
  const reload = () => providersView({ projectId });
  await loadInto(
    page.main,
    () => get(`/projects/${projectId}/providers`),
    ({ providers }) => [
      pageHead('Providers', 'Where prompts are sent. Rate limits and prices are per provider.'),
      providers.length
        ? h(
            'div',
            { class: 'table-wrap block' },
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
                  h('th', null, 'Type'),
                  h('th', null, 'Model'),
                  h('th', { class: 'num' }, 'Req/min'),
                  h('th', { class: 'hide-sm' }, 'Price / 1M tok'),
                  h('th', null, 'Key'),
                  h('th', null, ''),
                ),
              ),
              h(
                'tbody',
                null,
                providers.map((p) =>
                  h(
                    'tr',
                    null,
                    h('td', null, p.name),
                    h(
                      'td',
                      null,
                      h('span', { class: 'tag' }, p.kind === 'SIMULATED' ? 'simulated' : 'openai-compatible'),
                    ),
                    h('td', { class: 'mono' }, p.model),
                    h('td', { class: 'num' }, p.requestsPerMinute),
                    h(
                      'td',
                      { class: 'hide-sm muted' },
                      `$${p.inputCostPerMTok} in · $${p.outputCostPerMTok} out`,
                    ),
                    h('td', { class: 'muted' }, p.hasApiKey ? `••••${p.apiKeyLast4}` : '—'),
                    h(
                      'td',
                      null,
                      editRow(projectId, p, reload),
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'link',
                          onclick: async () => {
                            if (!confirmAction(`Delete provider "${p.name}"?`)) return;
                            try {
                              await del(`/projects/${projectId}/providers/${p.id}`);
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
        : emptyState('No providers yet', 'Add the simulated provider to try PromptGate without an API key.'),
      h(
        'section',
        { class: 'block', style: { marginTop: '24px' } },
        h('header', null, h('h2', null, 'Add a provider')),
        h('div', { class: 'panel panel-body' }, providerForm(projectId, reload)),
      ),
    ],
  );
}
