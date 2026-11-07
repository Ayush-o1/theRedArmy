// Minimal {{variable}} templating. Deliberately not a full template language:
// prompts need substitution, not logic, and a tiny renderer is easy to reason about.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;

export class TemplateError extends Error {}

export function listVariables(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

// A missing variable is an error, not an empty string. Silently rendering
// "Summarize: " would make the test pass or fail for the wrong reason.
export function renderTemplate(template, variables) {
  const missing = listVariables(template).filter((name) => !(name in variables));
  if (missing.length > 0) {
    throw new TemplateError(`Missing template variable(s): ${missing.join(', ')}`);
  }
  return template.replace(PLACEHOLDER, (_, name) => {
    const value = variables[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}
