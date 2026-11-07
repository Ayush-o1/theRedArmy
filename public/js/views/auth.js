import { post } from '../api.js';
import { formValues, h, mount } from '../dom.js';
import { asyncForm, field } from '../components.js';
import { navigate } from '../router.js';
import { setSession, user } from '../session.js';

function intro() {
  return h(
    'div',
    { class: 'auth-intro' },
    h(
      'a',
      { class: 'brand', href: '#/login' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
      'theRedArmy',
    ),
    h('h1', null, 'Know which test cases broke before your prompt change ships.'),
    h(
      'p',
      null,
      'theRedArmy runs every version of a prompt against the same test suite in background workers, then shows you exactly which cases regressed.',
    ),
    h(
      'ol',
      null,
      h('li', null, 'Write test cases: input variables plus checks on the output.'),
      h('li', null, 'Run a prompt version against them, with retries and rate limiting handled for you.'),
      h('li', null, 'Compare runs side by side, or let CI fail the build on regressions.'),
    ),
  );
}

function authPage(title, form, footer) {
  if (user()) return navigate('/');
  mount(
    document.getElementById('app'),
    h(
      'div',
      { class: 'auth' },
      intro(),
      h('div', { class: 'auth-form' }, h('h2', null, title), form, h('p', { class: 'muted' }, footer)),
    ),
  );
  form.querySelector('input')?.focus();
}

export function loginView() {
  const form = asyncForm({
    submitLabel: 'Log in',
    children: [
      field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })),
      field(
        'Password',
        h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
      ),
    ],
    onSubmit: async (f) => {
      setSession(await post('/auth/login', formValues(f)));
      navigate('/');
    },
  });
  authPage('Log in', form, ['No account yet? ', h('a', { href: '#/signup' }, 'Create one')]);
}

export function signupView() {
  const form = asyncForm({
    submitLabel: 'Create account',
    children: [
      field('Name', h('input', { name: 'name', autocomplete: 'name', required: true })),
      field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })),
      field(
        'Password',
        h('input', {
          name: 'password',
          type: 'password',
          autocomplete: 'new-password',
          minlength: 10,
          required: true,
        }),
        'At least 10 characters.',
      ),
    ],
    onSubmit: async (f) => {
      setSession(await post('/auth/signup', formValues(f)));
      navigate('/');
    },
  });
  authPage('Create your account', form, ['Already have an account? ', h('a', { href: '#/login' }, 'Log in')]);
}
