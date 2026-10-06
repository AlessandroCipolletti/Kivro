import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.KIVRO_WEB_URL ?? 'http://localhost:3000', channel: process.env.KIVRO_BROWSER_CHANNEL ?? 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.CI ? {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 120_000,
  } : undefined,
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
