import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { conflict, unauthorized } from '../../lib/errors.js';

// Used when the email does not exist, so a failed login takes about as long
// for unknown emails as for wrong passwords (prevents user enumeration by timing).
const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password-just-for-timing');

const publicUser = (user) => ({ id: user.id, email: user.email, name: user.name });

export async function signup({ email, name, password }) {
  const passwordHash = await hashPassword(password);
  try {
    const user = await prisma.user.create({ data: { email, name, passwordHash } });
    return publicUser(user);
  } catch (err) {
    // Rely on the unique index instead of "check then insert", which has a race window.
    if (err.code === 'P2002') throw conflict('An account with this email already exists');
    throw err;
  }
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user
    ? await verifyPassword(password, user.passwordHash)
    : (await verifyPassword(password, await DUMMY_HASH_PROMISE), false);
  // Same message for both cases: do not reveal whether the email is registered.
  if (!valid) throw unauthorized('Invalid email or password');
  return publicUser(user);
}

export async function createSession(userId) {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);
  await prisma.session.create({
    data: { tokenHash: sha256(token), csrfToken, userId, expiresAt },
  });
  return { token, csrfToken, expiresAt };
}

export async function deleteSession(sessionId) {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}
