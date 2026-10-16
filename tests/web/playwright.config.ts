import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.ui.ts',
  fullyParallel: false,
  workers: 1,
  globalSetup: './setup.ts',
  timeout: 45000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'https://panel.fairisfair.ir',
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: ['--host-resolver-rules=MAP panel.fairisfair.ir 127.0.0.1'],
    },
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
    },
  ],
});
