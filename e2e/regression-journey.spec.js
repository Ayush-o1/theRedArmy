// The core user journey, through the real UI:
//   sign up -> project -> provider -> prompt -> suite with a check
//   -> run v1 (passes) -> save v2 that breaks the check
//   -> run v2 against v1 as baseline -> gate fails -> comparison shows the regression
import { expect, test } from '@playwright/test';

test('a prompt change that breaks a test case is caught as a regression', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  await page.goto('/#/signup');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a long enough password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText('No projects yet')).toBeVisible();
  await page.getByLabel('Project name').fill('E2E project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('Almost ready to run')).toBeVisible();

  // Provider: the simulated one (no API key needed). It echoes the prompt.
  await page.getByRole('link', { name: 'Providers' }).first().click();
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await page.getByLabel('Name').fill('sim');
  await page.getByLabel('Model').fill('echo-1');
  await page.getByLabel('Latency (ms)').fill('20');
  await expect(page.getByLabel('Base URL')).toBeHidden();
  await page.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByRole('cell', { name: 'echo-1' })).toBeVisible();

  // Prompt v1 includes the order number.
  await page.getByRole('link', { name: 'Prompts' }).first().click();
  await expect(page.getByRole('heading', { name: 'Prompts' })).toBeVisible();
  await page.getByLabel('Name').fill('reply');
  await page.getByLabel('Prompt template').fill('Ticket: {{ticket}} Order: {{order_id}}');
  await expect(page.getByText('order_id', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create prompt' }).click();
  await expect(page.getByRole('heading', { name: 'reply' })).toBeVisible();

  // Suite with one case that checks for the order number.
  await page.getByRole('link', { name: 'Test suites' }).click();
  await expect(page.getByRole('heading', { name: 'Test suites' })).toBeVisible();
  await page.getByLabel('Name').fill('core');
  await page.getByRole('button', { name: 'Create suite' }).click();
  await expect(page.getByRole('heading', { name: 'core' })).toBeVisible();
  await page.getByLabel('Case name').fill('refund');
  await page.getByLabel('Variables (JSON)').fill('{"ticket": "Refund please", "order_id": "A-42"}');
  await page.getByLabel('Check type').selectOption('contains');
  await page.getByLabel('value').fill('A-42');
  await page.getByRole('button', { name: 'Add case' }).click();
  await expect(page.getByRole('cell', { name: 'refund', exact: true })).toBeVisible();

  // Run v1: everything passes.
  await page.getByRole('link', { name: 'Runs' }).first().click();
  await expect(page.getByRole('heading', { name: 'Start a run' })).toBeVisible();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('Gate passed: every case passed')).toBeVisible({ timeout: 20_000 });
  const v1Url = page.url();
  const v1Id = v1Url.split('/').pop();

  // v2 drops the order number.
  await page.getByRole('link', { name: 'reply v1' }).click();
  await expect(page.getByRole('heading', { name: 'reply' })).toBeVisible();
  await page.getByLabel('Prompt template').fill('Ticket: {{ticket}}');
  await page.getByLabel('Change note').fill('Shorter');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText('Saved v2')).toBeVisible();

  // Run v2 against v1 as the baseline.
  await page.getByRole('link', { name: 'Runs' }).first().click();
  await expect(page.getByRole('heading', { name: 'Start a run' })).toBeVisible();
  await page.getByLabel('Version').selectOption({ label: 'v2 · Shorter' });
  await page.getByLabel('Baseline run').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('Gate failed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('1 case(s) regressed against the baseline')).toBeVisible();

  // The failing check explains itself.
  await page.locator('summary', { hasText: 'refund' }).click();
  await expect(page.getByText('Output does not contain "A-42"')).toBeVisible();

  // Comparison view.
  await page.getByRole('link', { name: 'Compare with baseline' }).click();
  await expect(page.getByRole('heading', { name: 'Compare runs' })).toBeVisible();
  await expect(page.getByText('1 regressed')).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(v1Id.slice(0, 8)) })).toBeVisible();
});

test('model output is rendered as text, never as HTML', async ({ page }) => {
  // Sign up and build a minimal project via the API (the UI journey is covered above).
  await page.goto('/#/signup');
  await page.getByLabel('Name').fill('XSS check');
  await page.getByLabel('Email').fill(`xss-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('a long enough password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  const api = async (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const me = await (await fetch('/api/auth/me')).json();
        const res = await fetch(`/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
          body: JSON.stringify(body),
        });
        return res.json();
      },
      { method, path, body },
    );

  const { project } = await api('POST', '/projects', { name: 'xss' });
  const base = `/projects/${project.id}`;
  const { provider } = await api('POST', `${base}/providers`, {
    name: 's',
    kind: 'SIMULATED',
    model: 'echo',
    settings: { latencyMs: 5 },
  });
  const { prompt } = await api('POST', `${base}/prompts`, {
    name: 'p',
    version: { template: '{{payload}}' },
  });
  const payload = '<img src=x onerror="window.__pwned=true"><script>window.__pwned=true</script>';
  const { suite } = await api('POST', `${base}/suites`, {
    name: 's',
    cases: [{ name: 'xss', variables: { payload } }],
  });
  const { run } = await api('POST', `${base}/runs`, {
    promptVersionId: prompt.versions[0].id,
    suiteId: suite.id,
    providerConfigId: provider.id,
  });

  await page.goto(`/#/p/${project.id}/runs/${run.id}`);
  await expect(page.getByText('Gate passed')).toBeVisible({ timeout: 20_000 });
  await page.locator('summary', { hasText: 'xss' }).click();
  await expect(page.locator('pre').filter({ hasText: '<script>' }).first()).toBeVisible();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});
