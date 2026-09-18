import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";
// The landing project's own port (see playwright.config.ts) — its server runs with no
// ADVANCE_HUB configured, the real pre-launch state every route must degrade to honestly.
const UNCONFIGURED_PORT = Number(process.env.E2E_PORT ?? 3107);

test.describe("/auctions", () => {
  test("lists the fixture's live auction and its recent (ended) ones", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/auctions");
    await expect(page).toHaveTitle(/Auctions/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every note, priced by the market");
    await expect(page.getByRole("heading", { level: 2, name: /Live \(1\)/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /Recent \(2\)/ })).toBeVisible();

    const rows = page.getByRole("link").filter({ hasText: "Auction #" });
    await expect(rows).toHaveCount(3);

    expect(problems).toEqual([]);
  });

  test("each row links to its own auction detail page", async ({ page }) => {
    await page.goto("/auctions");
    const row = page.getByRole("link").filter({ hasText: "Auction #1" });
    await expect(row).toHaveAttribute("href", "/auctions/1");
  });

  test("the live auction shows a Live badge, the ended ones Graduated", async ({ page }) => {
    await page.goto("/auctions");
    const live = page.getByRole("link").filter({ hasText: "Auction #1" });
    await expect(live.getByText("Live", { exact: true })).toBeVisible();
    const ended = page.getByRole("link").filter({ hasText: "Auction #2" });
    await expect(ended.getByText("Graduated", { exact: true })).toBeVisible();
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/auctions");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/auctions");
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/auctions");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/auctions-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/auctions, unconfigured (no loans yet)", () => {
  test("prints an honest empty state instead of crashing", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`http://localhost:${UNCONFIGURED_PORT}/auctions`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("No loan has opened an auction yet.")).toBeVisible();

    expect(problems).toEqual([]);
  });
});
