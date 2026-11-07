// Helpers shared by the project-level views.
import { get } from '../api.js';
import { mount } from '../dom.js';
import { appShell } from '../layout.js';
import { emptyState, errorAlert, loading } from '../components.js';
import { h } from '../dom.js';

/**
 * Loads the project and renders the shell around it.
 * Returns { main, project }, or null after rendering an error page.
 */
export async function projectPage(projectId, active) {
  let main = appShell();
  mount(main, loading());
  try {
    const { project } = await get(`/projects/${projectId}`);
    main = appShell({ project, active });
    mount(main, loading());
    return { main, project };
  } catch (err) {
    mount(
      main,
      err.status === 404
        ? emptyState(
            'Project not found',
            'It may have been deleted, or it belongs to another account.',
            h('a', { href: '#/' }, 'All projects'),
          )
        : errorAlert(err),
    );
    return null;
  }
}

/**
 * Runs `load`, then renders its result with `render` into `main`.
 * If the user navigated away while loading, `main` is detached and nothing
 * is rendered (so a slow response cannot overwrite the newer page).
 */
export async function loadInto(main, load, render) {
  try {
    const data = await load();
    if (!main.isConnected) return;
    mount(main, render(data));
  } catch (err) {
    if (main.isConnected) mount(main, errorAlert(err));
  }
}
