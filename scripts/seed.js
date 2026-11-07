// Creates a demo account with a project that shows a real regression:
//   v1 of the prompt includes the order number; v2 "simplifies" the prompt
//   and drops it, so every case that checks for the order number regresses.
//
// It queues two runs (v1, then v2 with v1 as its baseline). Start the worker
// (`npm run worker`) and they will execute.
//
// The demo uses the simulated provider, which echoes the prompt back. It shows
// the pipeline (queueing, retries, caching, comparison), not model quality.
//
// Usage: npm run db:seed    (safe to re-run: it replaces the demo account)
import { prisma } from '../src/db.js';
import { redis } from '../src/redis.js';
import { hashPassword } from '../src/lib/crypto.js';
import { createRun } from '../src/modules/runs/runs.service.js';

const DEMO_EMAIL = 'demo@promptgate.local';
const DEMO_PASSWORD = 'promptgate-demo';

const tickets = [
  ['refund-double-charge', 'I was charged twice for my order', 'A-1001'],
  ['late-delivery', 'My parcel is a week late', 'A-1002'],
  ['wrong-size', 'The shoes I received are the wrong size', 'A-1003'],
  ['cancel-order', 'Please cancel my order before it ships', 'A-1004'],
  ['damaged-item', 'The lamp arrived broken', 'A-1005'],
  ['address-change', 'Can I change the delivery address?', 'A-1006'],
];

async function main() {
  // Remove a previous demo account. Runs go first because they RESTRICT the
  // deletion of the prompt versions they used (run history must stay valid).
  await prisma.run.deleteMany({ where: { project: { owner: { email: DEMO_EMAIL } } } });
  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });

  const user = await prisma.user.create({
    data: { email: DEMO_EMAIL, name: 'Demo User', passwordHash: await hashPassword(DEMO_PASSWORD) },
  });
  const project = await prisma.project.create({
    data: {
      ownerId: user.id,
      name: 'Support assistant',
      description: 'Replies to customer support tickets for an online store.',
    },
  });
  const provider = await prisma.providerConfig.create({
    data: {
      projectId: project.id,
      name: 'simulator',
      kind: 'SIMULATED',
      model: 'echo-1',
      requestsPerMinute: 120,
      inputCostPerMTok: 0.15,
      outputCostPerMTok: 0.6,
      // A 15% random 503 rate, so the demo shows retries happening.
      settings: { latencyMs: 400, mode: 'echo', errorRate: 0.15 },
    },
  });

  const prompt = await prisma.prompt.create({
    data: {
      projectId: project.id,
      name: 'ticket-reply',
      description: 'First reply to a new support ticket.',
      latestVersion: 2,
      versions: {
        create: [
          {
            version: 1,
            systemPrompt: 'You are a friendly support agent for an online store.',
            template:
              'Customer ticket: {{ticket}}\nOrder number: {{order_id}}\n\nWrite a short reply. Always mention the order number.',
            note: 'Initial version',
          },
          {
            version: 2,
            systemPrompt: 'You are a friendly support agent for an online store.',
            template: 'Customer ticket: {{ticket}}\n\nWrite a short reply.',
            note: 'Shorter prompt to cut token cost',
          },
        ],
      },
    },
    include: { versions: { orderBy: { version: 'asc' } } },
  });

  const suite = await prisma.suite.create({
    data: {
      projectId: project.id,
      name: 'core-tickets',
      description: 'The most common ticket types.',
      cases: {
        create: tickets.map(([name, ticket, orderId]) => ({
          name,
          variables: { ticket, order_id: orderId },
          assertions: [
            { type: 'contains', value: orderId, caseSensitive: false },
            { type: 'not_contains', value: 'password', caseSensitive: false },
            { type: 'max_length', value: 600 },
          ],
        })),
      },
    },
  });

  const { run: v1Run } = await createRun(project.id, {
    promptVersionId: prompt.versions[0].id,
    suiteId: suite.id,
    providerConfigId: provider.id,
    useCache: true,
  });
  await createRun(project.id, {
    promptVersionId: prompt.versions[1].id,
    suiteId: suite.id,
    providerConfigId: provider.id,
    baselineRunId: v1Run.id,
    useCache: true,
  });

  console.log(`Seeded demo project "${project.name}" with 2 queued runs.`);
  console.log(`Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log('Start the worker (npm run worker) to execute the runs.');
}

try {
  await main();
} finally {
  await prisma.$disconnect();
  await redis.quit();
}
