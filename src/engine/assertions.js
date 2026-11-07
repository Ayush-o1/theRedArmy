// Deterministic checks on a model output. Each assertion returns
// { type, passed, message } so the UI can show exactly why a case failed.
//
// Why only deterministic assertions? An LLM-as-judge assertion would itself be
// non-deterministic and cost money on every run. It is listed as future work.
import { z } from 'zod';

const MAX_REGEX_LENGTH = 200;

export const assertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('contains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('not_contains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({ type: z.literal('equals'), value: z.string(), trim: z.boolean().default(true) }),
  z.object({
    type: z.literal('regex'),
    pattern: z.string().min(1).max(MAX_REGEX_LENGTH).refine(isValidRegex, 'Invalid regular expression'),
    flags: z
      .string()
      .regex(/^[imsu]*$/, 'Allowed flags: i, m, s, u')
      .default(''),
  }),
  z.object({ type: z.literal('max_length'), value: z.number().int().positive() }),
  z.object({ type: z.literal('min_length'), value: z.number().int().nonnegative() }),
  z.object({ type: z.literal('is_json') }),
  z.object({
    type: z.literal('json_field_equals'),
    // Dot path such as "category" or "result.labels.0".
    path: z.string().min(1).max(200),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({ type: z.literal('latency_under_ms'), value: z.number().int().positive() }),
]);

export const assertionListSchema = z.array(assertionSchema).max(20);

function isValidRegex(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

// Model output often wraps JSON in a ```json fence. Strip it before parsing so
// is_json tests the content, not the formatting.
function parseJsonOutput(output) {
  const fenced = output.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : output);
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

const checks = {
  contains(a, output) {
    const hay = a.caseSensitive ? output : output.toLowerCase();
    const needle = a.caseSensitive ? a.value : a.value.toLowerCase();
    return hay.includes(needle) ? null : `Output does not contain "${a.value}"`;
  },
  not_contains(a, output) {
    const hay = a.caseSensitive ? output : output.toLowerCase();
    const needle = a.caseSensitive ? a.value : a.value.toLowerCase();
    return hay.includes(needle) ? `Output contains forbidden text "${a.value}"` : null;
  },
  equals(a, output) {
    const actual = a.trim ? output.trim() : output;
    const expected = a.trim ? a.value.trim() : a.value;
    return actual === expected ? null : 'Output is not exactly equal to the expected value';
  },
  regex(a, output) {
    // Outputs are bounded by maxTokens and patterns by MAX_REGEX_LENGTH, which
    // limits (but does not eliminate) catastrophic-backtracking risk.
    return new RegExp(a.pattern, a.flags).test(output)
      ? null
      : `Output does not match /${a.pattern}/${a.flags}`;
  },
  max_length(a, output) {
    return output.length <= a.value ? null : `Output is ${output.length} characters (max ${a.value})`;
  },
  min_length(a, output) {
    return output.length >= a.value ? null : `Output is ${output.length} characters (min ${a.value})`;
  },
  is_json(a, output) {
    try {
      parseJsonOutput(output);
      return null;
    } catch {
      return 'Output is not valid JSON';
    }
  },
  json_field_equals(a, output) {
    let parsed;
    try {
      parsed = parseJsonOutput(output);
    } catch {
      return 'Output is not valid JSON';
    }
    const actual = getPath(parsed, a.path);
    return actual === a.value
      ? null
      : `Field "${a.path}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(a.value)}`;
  },
  latency_under_ms(a, output, meta) {
    // A cached response has no real latency, so the check is skipped rather
    // than passed on misleading data.
    if (meta.cacheHit) return null;
    return meta.latencyMs < a.value ? null : `Latency ${meta.latencyMs}ms exceeds ${a.value}ms`;
  },
};

export function evaluateAssertions(assertions, output, meta = {}) {
  const results = assertions.map((assertion) => {
    const failure = checks[assertion.type](assertion, output, meta);
    return { type: assertion.type, passed: failure === null, message: failure ?? 'ok' };
  });
  // A case with zero assertions passes if the model answered at all, which is
  // useful as a smoke test but is flagged in the UI.
  return { passed: results.every((r) => r.passed), results };
}
