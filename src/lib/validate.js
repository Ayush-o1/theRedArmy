import { badRequest } from './errors.js';

// Parses untrusted input with a zod schema. On failure, returns a 400 that
// lists every invalid field, so the UI can show all problems at once.
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw badRequest('Validation failed', details);
  }
  return result.data;
}
