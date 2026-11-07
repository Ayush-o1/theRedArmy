// Hash-based router: #/p/<id>/runs -> a view function.
//
// Hash routing needs no server configuration (every URL loads index.html) and
// works with Express's static file serving as-is.
//
// A view may return a cleanup function (e.g. to stop polling). It is called
// before the next view renders.

const routes = [];
let cleanup = null;

export function route(pattern, view) {
  // '/p/:projectId/runs/:runId' -> regex with named groups
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ regex, view });
}

export function navigate(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
}

export function currentQuery() {
  const [, query = ''] = location.hash.split('?');
  return new URLSearchParams(query);
}

export async function render() {
  const [path] = location.hash.slice(1).split('?');
  const target = path || '/';
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  for (const { regex, view } of routes) {
    const match = target.match(regex);
    if (match) {
      const result = await view(match.groups ?? {});
      if (typeof result === 'function') cleanup = result;
      window.scrollTo(0, 0);
      return;
    }
  }
  navigate('/');
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  render();
}
