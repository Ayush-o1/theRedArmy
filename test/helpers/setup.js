// Shared helpers for integration tests. They run against a real Postgres test
// database and Redis (db 1), because the behaviour under test (row locks,
// unique constraints, Lua scripts) is exactly what a mock would hide.
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { redis } from '../../src/redis.js';
import { Worker } from '../../src/engine/worker.js';

export const app = createApp();

export async function resetState() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE users, sessions, projects, provider_configs, prompts, prompt_versions,
             suites, test_cases, runs, run_cases, api_keys, cached_responses CASCADE`);
  await redis.flushdb();
}

export async function closeConnections() {
  await prisma.$disconnect();
  await redis.quit();
}

// Names for test accounts. Tests that need two separate tenants pass a name
// explicitly (for example signedInClient({ name: 'Aditi Rao' })) so the
// intent reads clearly; everyone else gets the next name from this list.
const TEST_USERS = ['Aarav Mehta', 'Aditi Rao', 'Rohan Iyer', 'Priya Nair', 'Kabir Shah', 'Ananya Das'];
let userCounter = 0;

function emailFor(name) {
  // A counter and timestamp keep emails unique across tests sharing a name.
  // .test is reserved (RFC 2606), so these never reach a real mailbox.
  const local = name.toLowerCase().replace(/[^a-z]+/g, '.');
  return `${local}.${userCounter}.${Date.now()}@theredarmy.test`;
}

/**
 * Signs up a fresh user and returns a client that sends the session cookie
 * and CSRF header automatically.
 */
export async function signedInClient(overrides = {}) {
  userCounter += 1;
  const agent = request.agent(app);
  const name = overrides.name ?? TEST_USERS[(userCounter - 1) % TEST_USERS.length];
  const credentials = {
    name,
    email: emailFor(name),
    password: 'correct horse battery',
    ...overrides,
  };
  const res = await agent.post('/api/auth/signup').send(credentials).expect(201);
  const csrf = res.body.csrfToken;
  const withCsrf = (req) => req.set('x-csrf-token', csrf);
  return {
    agent,
    user: res.body.user,
    credentials,
    get: (url) => agent.get(url),
    post: (url, body) => withCsrf(agent.post(url)).send(body),
    patch: (url, body) => withCsrf(agent.patch(url)).send(body),
    delete: (url) => withCsrf(agent.delete(url)),
  };
}

/** Creates a project with a simulated provider, one prompt and one suite. */
export async function createFixture(
  client,
  { providerSettings = {}, cases, template, temperature = 0 } = {},
) {
  const project = (await client.post('/api/projects', { name: 'Support bot' }).expect(201)).body.project;
  const base = `/api/projects/${project.id}`;
  const provider = (
    await client
      .post(`${base}/providers`, {
        name: 'sim',
        kind: 'SIMULATED',
        model: 'echo-1',
        requestsPerMinute: 6000,
        inputCostPerMTok: 1,
        outputCostPerMTok: 2,
        settings: { latencyMs: 5, ...providerSettings },
      })
      .expect(201)
  ).body.provider;
  const prompt = (
    await client
      .post(`${base}/prompts`, {
        name: 'triage',
        version: { template: template ?? 'Ticket: {{ticket}}', temperature },
      })
      .expect(201)
  ).body.prompt;
  const suite = (
    await client
      .post(`${base}/suites`, {
        name: 'core',
        cases: cases ?? [
          {
            name: 'refund',
            variables: { ticket: 'I want a refund' },
            assertions: [{ type: 'contains', value: 'refund' }],
          },
          {
            name: 'login',
            variables: { ticket: 'Cannot log in' },
            assertions: [{ type: 'contains', value: 'log in' }],
          },
          {
            name: 'shipping',
            variables: { ticket: 'Where is my parcel' },
            assertions: [{ type: 'contains', value: 'parcel' }],
          },
        ],
      })
      .expect(201)
  ).body.suite;
  return { project, base, provider, prompt, version: prompt.versions[0], suite };
}

export function startRun(client, fixture, overrides = {}) {
  return client.post(`${fixture.base}/runs`, {
    promptVersionId: fixture.version.id,
    suiteId: fixture.suite.id,
    providerConfigId: fixture.provider.id,
    ...overrides,
  });
}

export function newWorker(options = {}) {
  return new Worker({ concurrency: 4, leaseSeconds: 30, ...options });
}

/**
 * Drives a worker by hand (no timers) until the run reaches a final state.
 * Jobs scheduled for later (retries with backoff) are waited for.
 */
export async function runToCompletion(worker, runId, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await worker.tick();
    await worker.drain();
    const run = await prisma.run.findUnique({ where: { id: runId } });
    if (run.status === 'COMPLETED' || run.status === 'CANCELLED') return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
}
