// Who is logged in. The session itself is an httpOnly cookie this code cannot
// read; /api/auth/me tells us the user and hands over the CSRF token.
import { get, post, setCsrfToken } from './api.js';

let currentUser = null;

export function user() {
  return currentUser;
}

export async function restoreSession() {
  try {
    const data = await get('/auth/me');
    setSession(data);
  } catch {
    currentUser = null;
  }
  return currentUser;
}

export function setSession({ user: u, csrfToken }) {
  currentUser = u;
  setCsrfToken(csrfToken);
}

export async function logout() {
  await post('/auth/logout').catch(() => {});
  currentUser = null;
  setCsrfToken(null);
}
