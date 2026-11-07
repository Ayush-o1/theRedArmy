import { AppError } from '../lib/errors.js';

// Every error response has the same shape:
//   { "error": { "code": "...", "message": "...", "details": [...] } }
export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by their 4 arguments.
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  // express.json() raises these for bad bodies.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
  }
  // Anything else is a bug: log everything, reveal nothing.
  (req.log ?? console).error({ err }, 'unhandled error');
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong', requestId: req.id },
  });
}
