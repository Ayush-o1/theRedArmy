// The app chrome: top bar, plus the project side navigation when inside a
// project. Returns the <main> element that the view fills in.
import { h, mount } from './dom.js';
import { navigate } from './router.js';
import { logout, user } from './session.js';

const PROJECT_NAV = [
  ['runs', 'Runs'],
  ['prompts', 'Prompts'],
  ['suites', 'Test suites'],
  ['providers', 'Providers'],
  ['settings', 'Settings & CI'],
];

function topbar(project) {
  return h(
    'header',
    { class: 'topbar' },
    h(
      'a',
      { class: 'brand', href: '#/' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
      'theRedArmy',
    ),
    project
      ? h(
          'nav',
          { class: 'crumb', 'aria-label': 'Breadcrumb' },
          h('span', { 'aria-hidden': 'true' }, '/'),
          h('a', { href: `#/p/${project.id}/runs` }, project.name),
        )
      : null,
    h('div', { class: 'spacer' }),
    h('span', { class: 'user' }, user()?.email),
    h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          await logout();
          navigate('/login');
        },
      },
      'Log out',
    ),
  );
}

export function appShell({ project = null, active = null } = {}) {
  const main = h('main', { class: project ? 'content' : 'page-narrow', id: 'main' });
  const app = document.getElementById('app');
  if (!project) {
    mount(app, topbar(null), main);
    return main;
  }
  const nav = h(
    'nav',
    { class: 'sidenav', 'aria-label': 'Project' },
    PROJECT_NAV.map(([key, label]) =>
      h('a', { href: `#/p/${project.id}/${key}`, 'aria-current': key === active ? 'page' : null }, label),
    ),
  );
  mount(app, topbar(project), h('div', { class: 'layout' }, nav, main));
  return main;
}
