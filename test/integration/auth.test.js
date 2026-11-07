import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, closeConnections, createFixture, resetState, signedInClient } from '../helpers/setup.js';
import { prisma } from '../../src/db.js';

beforeEach(resetState);
after(closeConnections);

describe('authentication', () => {
  test('signup sets an httpOnly session cookie and stores only a password hash', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({
        email: 'Neha.Kulkarni@TheRedArmy.test',
        name: 'Neha Kulkarni',
        password: 'long enough password',
      })
      .expect(201);
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /pg_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(res.body.user.email, 'neha.kulkarni@theredarmy.test', 'emails are normalized to lower case');

    const user = await prisma.user.findUnique({ where: { email: 'neha.kulkarni@theredarmy.test' } });
    assert.match(user.passwordHash, /^scrypt\$/);
    const session = await prisma.session.findFirst({ where: { userId: user.id } });
    assert.ok(!cookie.includes(session.tokenHash), 'the cookie holds the token, the DB only its hash');
  });

  test('duplicate email returns 409', async () => {
    const body = {
      email: 'arjun.menon@theredarmy.test',
      name: 'Arjun Menon',
      password: 'long enough password',
    };
    await request(app).post('/api/auth/signup').send(body).expect(201);
    const res = await request(app).post('/api/auth/signup').send(body).expect(409);
    assert.equal(res.body.error.code, 'conflict');
  });

  test('validation errors list every invalid field', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'nope', password: 'short' })
      .expect(400);
    const paths = res.body.error.details.map((d) => d.path).sort();
    assert.deepEqual(paths, ['email', 'name', 'password']);
  });

  test('wrong password and unknown email get the same response', async () => {
    const { credentials } = await signedInClient();
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: 'not the password' })
      .expect(401);
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not.registered@theredarmy.test', password: 'not the password' })
      .expect(401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
  });

  test('login is rate limited per IP and email', async () => {
    const { credentials } = await signedInClient();
    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: credentials.email, password: 'wrong password' })
        .expect(401);
    }
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: credentials.password })
      .expect(429);
    assert.ok(Number(res.headers['retry-after']) > 0);
  });

  test('state-changing requests without the CSRF token are rejected', async () => {
    const client = await signedInClient();
    await client.agent.post('/api/projects').send({ name: 'x' }).expect(403);
    await client.post('/api/projects', { name: 'x' }).expect(201);
  });

  test('logout invalidates the session server-side', async () => {
    const client = await signedInClient();
    await client.get('/api/auth/me').expect(200);
    await client.post('/api/auth/logout').expect(204);
    await client.get('/api/auth/me').expect(401);
  });
});

describe('authorization between tenants', () => {
  test("another user's project and its resources look like they do not exist", async () => {
    const aditi = await signedInClient({ name: 'Aditi Rao' });
    const rohan = await signedInClient({ name: 'Rohan Iyer' });
    const aditiProject = await createFixture(aditi);

    await rohan.get(aditiProject.base).expect(404);
    await rohan.get(`${aditiProject.base}/suites/${aditiProject.suite.id}`).expect(404);
    await rohan.delete(aditiProject.base).expect(404);
    const list = await rohan.get('/api/projects').expect(200);
    assert.equal(list.body.projects.length, 0);
  });

  test("a run cannot reference another tenant's suite or provider", async () => {
    const aditi = await signedInClient({ name: 'Aditi Rao' });
    const rohan = await signedInClient({ name: 'Rohan Iyer' });
    const aditiProject = await createFixture(aditi);
    const rohanProject = await createFixture(rohan);

    // Rohan's own project, but Aditi's suite id.
    const res = await rohan
      .post(`${rohanProject.base}/runs`, {
        promptVersionId: rohanProject.version.id,
        suiteId: aditiProject.suite.id,
        providerConfigId: rohanProject.provider.id,
      })
      .expect(404);
    assert.match(res.body.error.message, /Suite/);
    assert.equal(await prisma.run.count(), 0, 'nothing was created');
  });

  test('malformed ids return 404 instead of a database error', async () => {
    const client = await signedInClient();
    const f = await createFixture(client);
    await client.get('/api/projects/not-a-uuid').expect(404);
    await client.get(`${f.base}/runs/123`).expect(404);
    await client.delete(`${f.base}/suites/${f.suite.id}/cases/abc`).expect(404);
  });
});
