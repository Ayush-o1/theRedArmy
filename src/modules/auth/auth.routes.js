import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { parse } from '../../lib/validate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { SESSION_COOKIE, requireCsrf, requireUser } from '../../middleware/auth.js';
import * as auth from './auth.service.js';

const email = z.string().trim().toLowerCase().email().max(254);

const signupSchema = z.object({
  email,
  name: z.string().trim().min(1).max(80),
  // Length beats complexity rules; 10+ characters, capped to bound hashing cost.
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

function setSessionCookie(res, session) {
  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true, // not readable from JavaScript, so XSS cannot steal it
    sameSite: 'lax', // not sent on cross-site POSTs
    secure: config.isProduction,
    expires: session.expiresAt,
    path: '/',
  });
}

export const authRouter = Router();

authRouter.post(
  '/signup',
  rateLimit({ name: 'signup', limit: 20, windowSeconds: 3600, keyFn: (req) => req.ip }),
  async (req, res) => {
    const input = parse(signupSchema, req.body);
    const user = await auth.signup(input);
    const session = await auth.createSession(user.id);
    setSessionCookie(res, session);
    res.status(201).json({ user, csrfToken: session.csrfToken });
  },
);

authRouter.post(
  '/login',
  // Keyed on IP + email so one attacker cannot lock out every user,
  // but cannot brute-force a single account quickly either.
  rateLimit({
    name: 'login',
    limit: 10,
    windowSeconds: 15 * 60,
    keyFn: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
  }),
  async (req, res) => {
    const input = parse(loginSchema, req.body);
    const user = await auth.login(input);
    const session = await auth.createSession(user.id);
    setSessionCookie(res, session);
    res.json({ user, csrfToken: session.csrfToken });
  },
);

authRouter.post('/logout', requireUser, requireCsrf, async (req, res) => {
  await auth.deleteSession(req.session.id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.status(204).end();
});

authRouter.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user, csrfToken: req.session.csrfToken });
});
