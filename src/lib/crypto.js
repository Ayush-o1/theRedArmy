// Security-sensitive helpers, kept in one small file so they are easy to review.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);

// scrypt is built into Node and is memory-hard, which makes brute-forcing a
// stolen hash expensive. Using it avoids a native dependency such as bcrypt.
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  // Constant-time comparison so response timing does not leak how many bytes matched.
  return crypto.timingSafeEqual(derived, expected);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// AES-256-GCM gives confidentiality and integrity: a tampered ciphertext fails
// to decrypt instead of silently producing garbage.
const encryptionKey = Buffer.from(config.ENCRYPTION_KEY, 'base64');

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, data].map((b) => b.toString('base64')).join(':');
}

export function decrypt(payload) {
  const [iv, tag, data] = payload.split(':').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
