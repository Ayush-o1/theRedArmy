// End-to-end tests drive the real UI in Chromium against a real API server and
// worker, both pointed at the test database on port 3100 (so a dev server on
// 3000 can keep running). Run with: npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

const env = { PORT: '3100', LOG_LEVEL: 'warn' };

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // One shell command starts the worker in the background and the API in the
  // foreground. Playwright stops the whole process group when tests finish.
  webServer: {
    command:
      'node --env-file-if-exists=.env.test src/worker.js & node --env-file-if-exists=.env.test src/server.js',
    url: 'http://localhost:3100/api/health',
    env,
    reuseExistingServer: false,
  },
});
