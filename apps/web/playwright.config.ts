import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./e2e", outputDir: "./test-results", timeout: 120_000,
  fullyParallel: false, workers: 1, reporter: "list",
  use: { baseURL: process.env.KIVRO_WEB_URL || "http://localhost:3000", channel: process.env.KIVRO_BROWSER_CHANNEL ?? "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: process.env.CI ? {
    command: "pnpm dev",
    url: "http://localhost:3000",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    reuseExistingServer: false,
    timeout: 120_000,
  } : undefined,
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
