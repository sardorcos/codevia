import { defineConfig, devices } from '@playwright/test';

const chromiumPath = process.env.CHROMIUM_PATH || (process.env.CI ? undefined : '/opt/pw-browsers/chromium');

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/?e2e=1',
    // The UI follows the system language; most tests assert the Russian texts (see i18n.spec.ts for English).
    locale: 'ru-RU',
    trace: 'off',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'iphone-chromium',
      testIgnore: /ipad\.spec/,
      use: { ...devices['iPhone 14'], browserName: 'chromium', launchOptions: chromiumPath ? { executablePath: chromiumPath } : {} },
    },
    // iPad (and Mac "Designed for iPad"): the three-pane layout.
    {
      name: 'ipad-chromium',
      testMatch: /ipad\.spec/,
      use: { ...devices['iPad Pro 11 landscape'], browserName: 'chromium', launchOptions: chromiumPath ? { executablePath: chromiumPath } : {} },
    },
    // WebKit is the engine behind iOS; run it in CI (requires `npx playwright install webkit`).
    ...(process.env.E2E_WEBKIT
      ? [
          { name: 'iphone-webkit', testIgnore: /ipad\.spec/, use: { ...devices['iPhone 14'] } },
          { name: 'ipad-webkit', testMatch: /ipad\.spec/, use: { ...devices['iPad Pro 11 landscape'] } },
        ]
      : []),
  ],
});
