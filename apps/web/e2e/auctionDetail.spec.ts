import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";
const UNCONFIGURED_PORT = Number(process.env.E2E_PORT ?? 3107);

test.describe("/auctions/[loanId] — live auction", () => {
  test("shows the clearing-price chart, the raise and a disabled bid form", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/auctions/1");
    await expect(page).toHaveTitle(/Auction #1/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Auction #1");
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Clearing price" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Clearing price over/ }).first()).toBeVisible();

    // No NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID is configured for this server — the form renders
    // disabled with an explanation, never a crash.
    await expect(page.getByRole("heading", { level: 2, name: "Bid on this auction" })).toBeVisible();
    await expect(page.getByText(/Bidding needs a configured wallet environment/)).toBeVisible();
    const notesInput = page.getByLabel("Notes");
    await expect(notesInput).toBeDisabled();

    await expect(page.getByRole("link", { name: /The loan this auction funds/ })).toHaveAttribute("href", "/loans/1");

    expect(problems).toEqual([]);
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/auctions/1");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/auctions/1");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/auction-detail-live-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/auctions/[loanId] — ended, graduated", () => {
  test("shows Graduated and explains bidding has closed", async ({ page }) => {
    await page.goto("/auctions/2");
    await expect(page.getByText("Graduated", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/This auction has ended/)).toBeVisible();
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/auctions/2");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/auction-detail-ended-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/auctions/[loanId] — not found / invalid", () => {
  test("an id that never opened a loan shows a plain not-found message, never a stack trace", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/auctions/999");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("No loan #999 has opened");
    await expect(page.getByRole("link", { name: "Back to auctions" })).toHaveAttribute("href", "/auctions");

    expect(problems).toEqual([]);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/at\s+\S+\.(ts|tsx|js):\d+/);
  });

  test("a non-numeric id shows an invalid-id message", async ({ page }) => {
    await page.goto("/auctions/not-a-loan-id");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("doesn't look like a loan id");
  });
});

test.describe("/auctions/[loanId], unconfigured (no loans yet)", () => {
  test("prints an honest state instead of crashing", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`http://localhost:${UNCONFIGURED_PORT}/auctions/1`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(problems).toEqual([]);
  });
});
