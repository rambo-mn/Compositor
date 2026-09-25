// End-to-end tests: the built app (npm run build) driven through Playwright's Electron support.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
