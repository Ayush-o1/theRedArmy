// Retry delay for transient provider failures.
//
// "Full jitter" (AWS Architecture Blog, "Exponential Backoff and Jitter"):
// pick a random delay between 0 and the exponential cap. Without jitter, every
// job that hit the same 429 retries at the same moment and causes another 429.
const BASE_MS = 1000;
const MAX_MS = 60_000;

export function computeBackoffMs(attempt, { retryAfterMs, random = Math.random } = {}) {
  // The provider knows its own limits better than we do, so honor Retry-After.
  if (retryAfterMs != null && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_MS);
  const cap = Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * cap);
}

// Retry-After is either a number of seconds or an HTTP date.
export function parseRetryAfter(header, now = Date.now()) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
