import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3107);
const baseURL = `http://localhost:${port}`;
const chromePath = process.env.CHROME_PATH;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    channel: chromePath ? undefined : "chrome",
    launchOptions: chromePath ? { executablePath: chromePath } : undefined,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1440",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-390",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: `pnpm run build && pnpm exec next start -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
});
