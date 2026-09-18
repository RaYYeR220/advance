import { defineConfig } from "@playwright/test";

const landingPort = Number(process.env.E2E_PORT ?? 3107);
const underwritePort = Number(process.env.E2E_UNDERWRITE_PORT ?? 3108);
const fakeApiPort = Number(process.env.E2E_FAKE_API_PORT ?? 3109);
const fixturesPort = Number(process.env.E2E_FIXTURES_PORT ?? 3110);

const landingBaseURL = `http://localhost:${landingPort}`;
const underwriteBaseURL = `http://localhost:${underwritePort}`;
const fakeApiUrl = `http://localhost:${fakeApiPort}`;
const fixturesBaseURL = `http://localhost:${fixturesPort}`;

/** A syntactically valid but never-deployed hub address — `/underwrite/[token]` never reads
 * chain state (`score()` only calls the underwriter API), so this never triggers a live RPC
 * call; it only satisfies `loadWebEnv`'s "well-formed address" check. */
const DUMMY_HUB = "0x00000000000000000000000000000000000A11CE";

const chromePath = process.env.CHROME_PATH;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: chromePath ? undefined : "chrome",
    launchOptions: chromePath ? { executablePath: chromePath } : undefined,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "landing-1440",
      testMatch: /landing\.spec\.ts/,
      use: { baseURL: landingBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "landing-390",
      testMatch: /landing\.spec\.ts/,
      use: { baseURL: landingBaseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: "underwrite-1440",
      testMatch: /underwrite\.spec\.ts/,
      use: { baseURL: underwriteBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "underwrite-390",
      testMatch: /underwrite\.spec\.ts/,
      use: { baseURL: underwriteBaseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: "fixtures-1440",
      testMatch: [/auctions\.spec\.ts/, /auctionDetail\.spec\.ts/, /loanDetail\.spec\.ts/],
      use: { baseURL: fixturesBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "fixtures-390",
      testMatch: [/auctions\.spec\.ts/, /auctionDetail\.spec\.ts/, /loanDetail\.spec\.ts/],
      use: { baseURL: fixturesBaseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: [
    {
      // No ADVANCE_HUB/UNDERWRITER_API_URL: the true "nothing deployed yet" state the landing
      // page must render honestly, with zero live network calls.
      command: `pnpm run build && pnpm exec next start -p ${landingPort}`,
      url: landingBaseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: { NEXT_TELEMETRY_DISABLED: "1" },
    },
    {
      command: `node e2e/fixtures/fakeUnderwriter.mjs`,
      url: `${fakeApiUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { PORT: String(fakeApiPort) },
    },
    {
      // Reuses the first server's build output (waits for it, rather than building again) on a
      // second port, configured with a dummy hub and the fake underwriter above — a fake data
      // layer for `/underwrite/[token]`'s eligible/deny states, with no live chain involved.
      command: `node e2e/fixtures/waitForPort.mjs ${landingPort} && node e2e/fixtures/waitForPort.mjs ${fakeApiPort} && pnpm exec next start -p ${underwritePort}`,
      url: underwriteBaseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: { NEXT_TELEMETRY_DISABLED: "1", ADVANCE_HUB: DUMMY_HUB, UNDERWRITER_API_URL: fakeApiUrl },
    },
    {
      // Same build output again, on a third port, with `WEB_E2E_FIXTURES=1` — `lib/data.ts`
      // reads a fully in-memory fixture (three loans: a live auction, an active loan with
      // refusals/harvests/receipts, a repaid one) instead of a real chain, for
      // `/auctions*`/`/loans/[loanId]`.
      command: `node e2e/fixtures/waitForPort.mjs ${landingPort} && pnpm exec next start -p ${fixturesPort}`,
      url: fixturesBaseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: { NEXT_TELEMETRY_DISABLED: "1", ADVANCE_HUB: DUMMY_HUB, UNDERWRITER_API_URL: fakeApiUrl, WEB_E2E_FIXTURES: "1" },
    },
  ],
});
