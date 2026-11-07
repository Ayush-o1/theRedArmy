import pino from 'pino';
import { config } from '../config.js';

// Structured JSON logs. In development, pipe through `npx pino-pretty` for
// readable output. Credentials are redacted even if a caller logs them by mistake.
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.password'],
    censor: '[redacted]',
  },
});
