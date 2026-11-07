// Entry point: restore the session, register routes, start the router.
import { setUnauthorizedHandler } from './api.js';
import { navigate, route, startRouter } from './router.js';
import { restoreSession, user } from './session.js';
import { loginView, signupView } from './views/auth.js';
import { projectsView } from './views/projects.js';
import { runsView } from './views/runs.js';
import { runDetailView } from './views/runDetail.js';
import { compareView } from './views/compare.js';
import { promptsView, promptDetailView } from './views/prompts.js';
import { suitesView, suiteDetailView } from './views/suites.js';
import { providersView } from './views/providers.js';
import { settingsView } from './views/settings.js';

// Pages that need a logged-in user redirect to /login otherwise.
const authed = (view) => (params) => {
  if (!user()) {
    navigate('/login');
    return;
  }
  return view(params);
};

route('/login', loginView);
route('/signup', signupView);
route('/', authed(projectsView));
route(
  '/p/:projectId',
  authed(({ projectId }) => navigate(`/p/${projectId}/runs`)),
);
route('/p/:projectId/runs', authed(runsView));
route('/p/:projectId/runs/:runId', authed(runDetailView));
route('/p/:projectId/compare', authed(compareView));
route('/p/:projectId/prompts', authed(promptsView));
route('/p/:projectId/prompts/:promptId', authed(promptDetailView));
route('/p/:projectId/suites', authed(suitesView));
route('/p/:projectId/suites/:suiteId', authed(suiteDetailView));
route('/p/:projectId/providers', authed(providersView));
route('/p/:projectId/settings', authed(settingsView));

setUnauthorizedHandler(() => navigate('/login'));

await restoreSession();
startRouter();
