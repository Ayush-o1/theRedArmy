// Small reusable UI pieces. Each returns a DOM element.
import { h } from './dom.js';

const STATUS_STYLE = {
  PASSED: 'pass',
  COMPLETED: 'pass',
  FAILED: 'fail',
  ERROR: 'warn',
  CANCELLED: '',
  PENDING: '',
  QUEUED: 'active',
  RUNNING: 'active',
};

const STATUS_LABEL = { ERROR: 'Error', PENDING: 'Pending' };

export function statusBadge(status) {
  const label = STATUS_LABEL[status] ?? status.charAt(0) + status.slice(1).toLowerCase();
  return h('span', { class: `badge ${STATUS_STYLE[status] ?? ''}` }, label);
}

// A completed run's badge reflects its results, not just "it finished".
export function runOutcomeBadge(run) {
  if (run.status !== 'COMPLETED') return statusBadge(run.status);
  if (run.gate?.status === 'failed') return h('span', { class: 'badge fail' }, 'Gate failed');
  if (run.failedCases + run.erroredCases === 0) return h('span', { class: 'badge pass' }, 'All passed');
  return h('span', { class: 'badge fail' }, `${run.failedCases + run.erroredCases} not passing`);
}

export function progressBar({ total, passed = 0, failed = 0, errored = 0, running = 0 }) {
  const pct = (n) => (total ? `${(n / total) * 100}%` : '0%');
  return h(
    'div',
    {
      class: 'progress',
      role: 'img',
      'aria-label': `${passed} passed, ${failed} failed, ${errored} errored, ${running} running, of ${total}`,
    },
    h('span', { class: 'p-pass', style: { width: pct(passed) } }),
    h('span', { class: 'p-fail', style: { width: pct(failed) } }),
    h('span', { class: 'p-error', style: { width: pct(errored) } }),
    h('span', { class: 'p-run', style: { width: pct(running) } }),
  );
}

export function emptyState(title, text, ...actions) {
  return h(
    'div',
    { class: 'empty' },
    h('strong', null, title),
    text,
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export function loading(text = 'Loading…') {
  return h('p', { class: 'loading' }, text);
}

// Shows an ApiError, including per-field validation details when present.
export function errorAlert(err) {
  const details = err?.details?.length
    ? h(
        'ul',
        null,
        err.details.map((d) => h('li', null, d.path ? `${d.path}: ${d.message}` : d.message)),
      )
    : null;
  return h('div', { class: 'alert', role: 'alert' }, err?.message ?? String(err), details);
}

export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label),
    control,
    hint ? h('span', { class: 'hint' }, hint) : null,
  );
}

export function pageHead(title, subtitle, ...actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', null, h('h1', null, title), subtitle ? h('p', null, subtitle) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export function toast(message, { error = false } = {}) {
  const el = h('div', { class: `toast ${error ? 'error' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}

/**
 * Wires a form to an async submit handler: disables the button while
 * submitting and shows errors above the form. Returns the form element.
 */
export function asyncForm({ submitLabel, onSubmit, children, className = 'stack' }) {
  const errorSlot = h('div', { class: 'form-errors' });
  const button = h('button', { class: 'primary', type: 'submit' }, submitLabel);
  const form = h('form', { class: className, novalidate: true }, errorSlot, children, h('div', null, button));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();
    button.disabled = true;
    try {
      await onSubmit(form);
    } catch (err) {
      errorSlot.replaceChildren(errorAlert(err));
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

export function confirmAction(message) {
  // The native dialog is accessible and keyboard friendly; a custom modal
  // would add code without adding value here.
  return window.confirm(message);
}
