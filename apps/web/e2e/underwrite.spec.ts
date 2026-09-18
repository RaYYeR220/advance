import { expect, test } from "@playwright/test";

// Mirrors `e2e/fixtures/tokens.mjs` (the fake underwriter server's own constants) — duplicated
// rather than imported so this spec, type-checked as part of the app's TypeScript project,
// never needs a declaration file for a plain Node ESM fixture script.
const ELIGIBLE_TOKEN = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const DENY_TOKEN = "0xdededededededededededededededededededede";
const ERROR_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const SCREENSHOT_DIR = "e2e/__screenshots__";
const INVALID_TOKEN = "not-a-token";
const UNSEEN_TOKEN = "0x9999999999999999999999999999999999999999";

test.describe("/underwrite", () => {
  test("explains cost and validates the pasted address", async ({ page }) => {
    await page.goto("/underwrite");
    await expect(page).toHaveTitle(/Underwrite/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Paste a token, get a score");
    await expect(page.getByText("Free")).toBeVisible();
    await expect(page.getByText("Paid")).toBeVisible();

    const input = page.getByLabel("Token address");
    await input.fill("not an address");
    await page.getByRole("button", { name: "Score this token" }).click();
    await expect(page.getByText(/doesn't look like a token address/)).toBeVisible();
    await expect(page).toHaveURL(/\/underwrite$/);
  });

  test("navigates to the token's score page on a valid address", async ({ page }) => {
    await page.goto("/underwrite");
    await page.getByLabel("Token address").fill(ELIGIBLE_TOKEN);
    await page.getByRole("button", { name: "Score this token" }).click();
    await expect(page).toHaveURL(new RegExp(`/underwrite/${ELIGIBLE_TOKEN}$`));
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/underwrite");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/underwrite-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/underwrite/[token] — invalid token", () => {
  test("shows a clear message, never a stack trace", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`/underwrite/${INVALID_TOKEN}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("doesn't look like a token address");
    await expect(page.getByText(INVALID_TOKEN)).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to underwrite" })).toHaveAttribute("href", "/underwrite");
    expect(problems).toEqual([]);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/at\s+\S+\.(ts|tsx|js):\d+/);
  });
});

test.describe("/underwrite/[token] — eligible", () => {
  test("shows revenue windows, the haircut breakdown, the formula walk-through and terms", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`/underwrite/${ELIGIBLE_TOKEN}`);
    await expect(page.getByText("Eligible")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Revenue windows" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "The haircut, broken down" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Projection to terms" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Resulting terms" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Evidence" })).toBeVisible();

    // Every deny-reason threshold row is printed, with a fired/clear verdict.
    await expect(page.getByText("Top-5 wallet concentration")).toBeVisible();
    await expect(page.getByText(/fires|clear/).first()).toBeVisible();

    const evidenceLink = page.getByRole("link", { name: /Evidence bundle/ });
    await expect(evidenceLink).toHaveAttribute("href", /\/v1\/evidence\/0xab/);
    await expect(evidenceLink).toHaveAttribute("target", "_blank");

    expect(problems).toEqual([]);
  });

  test("re-derive note links the underwriter's evidence endpoint", async ({ page, request }) => {
    await page.goto(`/underwrite/${ELIGIBLE_TOKEN}`);
    const href = await page.getByRole("link", { name: /Evidence bundle/ }).getAttribute("href");
    expect(href).toBeTruthy();
    const res = await request.get(href!);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.token.toLowerCase()).toBe(ELIGIBLE_TOKEN);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto(`/underwrite/${ELIGIBLE_TOKEN}`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/underwrite-eligible-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/underwrite/[token] — denied", () => {
  test("shows every deny reason as a plain-language exhibit", async ({ page }) => {
    await page.goto(`/underwrite/${DENY_TOKEN}`);
    await expect(page.getByText("Not eligible yet")).toBeVisible();
    await expect(page.getByText("Exhibit A")).toBeVisible();
    await expect(page.getByText("Exhibit B")).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Token too young" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Trading too concentrated" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Evidence" })).toBeVisible();
  });

  test("a token Advance has never seen also denies, with a plain reason", async ({ page }) => {
    await page.goto(`/underwrite/${UNSEEN_TOKEN}`);
    await expect(page.getByText("Not eligible yet")).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Not a Bankr-launched token" })).toBeVisible();
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto(`/underwrite/${DENY_TOKEN}`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/underwrite-denied-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/underwrite/[token] — underwriter unreachable", () => {
  test("shows a friendly error, never a stack trace", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`/underwrite/${ERROR_TOKEN}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Can't score this token right now");
    await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
    expect(problems).toEqual([]);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/at\s+\S+\.(ts|tsx|js):\d+/);
  });
});

test.describe("responsive", () => {
  test("never scrolls sideways on the eligible result", async ({ page }) => {
    await page.goto(`/underwrite/${ELIGIBLE_TOKEN}`);
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
