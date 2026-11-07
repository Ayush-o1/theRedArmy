// Every provider adapter throws this, so the job processor only has to answer
// one question: "is it worth trying again?"
export class ProviderError extends Error {
  constructor(message, { retryable, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// 408 timeout, 409 conflict-on-busy, 429 rate limit and 5xx are transient.
// Other 4xx errors (bad key, unknown model, invalid request) will fail the
// same way every time, so retrying them would only waste quota.
export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
