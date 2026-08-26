import { defineConfig, devices } from "@playwright/test";

const testServerPort = Number(process.env.GERBER_VIEWER_TEST_PORT ?? 4173);
const testServerUrl = `http://127.0.0.1:${testServerPort}`;

export default defineConfig({
  testDir: "./tests/playwright",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: testServerUrl,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/static-server.mjs",
    url: testServerUrl,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
