// Errors that are safe to show to API clients. Anything else that reaches the
// error handler is treated as a bug: logged in full, returned as a generic 500.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'forbidden', message);
// Used for resources the caller cannot access, as well as ones that do not exist,
// so the API does not reveal which IDs belong to other users.
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const unprocessable = (message, details) => new AppError(422, 'unprocessable', message, details);
export const tooManyRequests = (retryAfterSeconds) => {
  const err = new AppError(429, 'rate_limited', 'Too many requests, slow down');
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
};
