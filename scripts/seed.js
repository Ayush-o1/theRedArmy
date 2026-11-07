// Creates a local demo account whose project shows a real regression.
//
// Monsoon Market is a fictional online store. Its support team tests the
// prompt that drafts first replies to customer tickets:
//   v1 quotes the customer's order number.
//   v2 "simplifies" the prompt to save tokens and drops the order number,
//      so every case that checks for the order number regresses.
// One case (a delivery-area question with no order) checks only things v2
// keeps, so the comparison also shows a case that still passes.
//
// It queues two runs (v1, then v2 with v1 as its baseline). Start the worker
// (`npm run worker`) and they will execute.
//
// The demo uses the simulated provider, which echoes the prompt back. It shows
// the pipeline (queueing, retries, caching, comparison), not model quality.
//
// Usage: npm run db:seed    (safe to re-run: it replaces the demo account)
//
// The credentials below are for local development only. Never run this
// seed against a deployment that other people can reach.
import { prisma } from '../src/db.js';
import { redis } from '../src/redis.js';
import { hashPassword } from '../src/lib/crypto.js';
import { createRun } from '../src/modules/runs/runs.service.js';

// .test is a reserved top-level domain (RFC 2606), so this address can never
// deliver mail to a real person.
const DEMO_EMAIL = 'aarav.mehta@theredarmy.test';
const DEMO_PASSWORD = 'theRedArmy-demo';
const DEMO_NAME = 'Aarav Mehta';

// Order numbers are passed as a separate variable and never appear in the
// ticket text. That is what makes the v2 regression visible: once the
// template stops including {{order_id}}, the order number is gone.
const tickets = [
  {
    name: 'duplicate-upi-payment',
    customer: 'Ishita Sharma',
    city: 'Delhi',
    orderId: 'MM-240117',
    ticket:
      'I paid ₹2,499 by UPI and the amount was debited twice from my account. Please refund the extra payment.',
  },
  {
    name: 'delayed-delivery',
    customer: 'Aditi Rao',
    city: 'Bengaluru',
    orderId: 'MM-240231',
    ticket: 'My order was due last Friday and the tracking page has not updated for four days.',
  },
  {
    name: 'wrong-size',
    customer: 'Rohan Iyer',
    city: 'Chennai',
    orderId: 'MM-240318',
    ticket: 'I ordered running shoes in size 9 but received size 7. Can I exchange them?',
  },
  {
    name: 'cancel-before-dispatch',
    customer: 'Priya Nair',
    city: 'Kochi',
    orderId: 'MM-240402',
    ticket:
      'Please cancel my order for two steel water bottles. I placed it by mistake and it has not shipped yet.',
  },
  {
    name: 'damaged-product',
    customer: 'Kabir Shah',
    city: 'Ahmedabad',
    orderId: 'MM-240455',
    ticket: 'The glass serving bowl arrived cracked. I have photos of the box and the bowl.',
  },
  {
    name: 'change-address',
    customer: 'Ananya Das',
    city: 'Kolkata',
    orderId: 'MM-240509',
    ticket: 'I have moved to a new flat in Salt Lake. Can you change the delivery address before it ships?',
  },
  {
    name: 'cod-refund',
    customer: 'Neha Kulkarni',
    city: 'Mumbai',
    orderId: 'MM-240611',
    ticket: 'I returned a kurta that I paid for with cash on delivery. How will I receive the ₹1,150 refund?',
  },
  {
    // No order yet: the checks only cover things v2 keeps, so this case
    // passes in both versions.
    name: 'pincode-serviceability',
    customer: 'Vikram Singh',
    city: 'Jaipur',
    orderId: 'not provided',
    ticket: 'Do you deliver to PIN code 302017? I would like to order a pressure cooker this week.',
    mustMention: '302017',
  },
];

const SYSTEM_PROMPT =
  'You are a support agent for Monsoon Market, an online store for home and kitchen goods. ' +
  'Be polite and brief. Never ask the customer for an OTP, card number or UPI PIN.';

function checksFor({ customer, orderId, mustMention }) {
  const firstName = customer.split(' ')[0];
  return [
    // The order-number check is the one v2 breaks.
    mustMention
      ? { type: 'contains', value: mustMention, caseSensitive: false }
      : { type: 'contains', value: orderId, caseSensitive: false },
    { type: 'contains', value: firstName, caseSensitive: false },
    { type: 'not_contains', value: 'OTP', caseSensitive: true },
    { type: 'max_length', value: 600 },
  ];
}

async function main() {
  // Remove a previous demo account. Runs go first because they RESTRICT the
  // deletion of the prompt versions they used (run history must stay valid).
  await prisma.run.deleteMany({ where: { project: { owner: { email: DEMO_EMAIL } } } });
  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });

  const user = await prisma.user.create({
    data: { email: DEMO_EMAIL, name: DEMO_NAME, passwordHash: await hashPassword(DEMO_PASSWORD) },
  });
  const project = await prisma.project.create({
    data: {
      ownerId: user.id,
      name: 'Monsoon Market — Customer Support',
      description: 'Drafts first replies to customer support tickets for an online home and kitchen store.',
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
            systemPrompt: SYSTEM_PROMPT,
            template:
              'Customer: {{customer_name}} ({{city}})\nOrder number: {{order_id}}\nMessage: {{ticket}}\n\n' +
              'Write a short reply. Greet the customer by first name and always quote the order number.',
            note: 'Initial version',
          },
          {
            version: 2,
            systemPrompt: SYSTEM_PROMPT,
            template:
              'Customer: {{customer_name}}\nMessage: {{ticket}}\n\nWrite a short reply. Greet the customer by first name.',
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
      description: 'The ticket types the support team sees most often.',
      cases: {
        create: tickets.map((t) => ({
          name: t.name,
          variables: { customer_name: t.customer, city: t.city, order_id: t.orderId, ticket: t.ticket },
          assertions: checksFor(t),
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

  console.log(`Seeded "${project.name}" with ${tickets.length} test cases and 2 queued runs.`);
  console.log(`Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD} (local development only).`);
  console.log('Start the worker (npm run worker) to execute the runs.');
}

try {
  await main();
} finally {
  await prisma.$disconnect();
  await redis.quit();
}
