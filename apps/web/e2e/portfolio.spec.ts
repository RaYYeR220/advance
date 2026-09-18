import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";
const UNCONFIGURED_PORT = Number(process.env.E2E_PORT ?? 3107);

test.describe("/portfolio, no wallet environment configured", () => {
  test("shows the disabled panel with an explanation, never a crash", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/portfolio");
    await expect(page).toHaveTitle(/Portfolio/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("What your wallet holds");
    await expect(page.getByRole("heading", { level: 2, name: "Your notes" })).toBeVisible();

    // No NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID is configured for this server — the panel renders
    // disabled with an explanation, the same pattern the auction bid form uses.
    await expect(page.getByText(/Reading your notes needs a configured wallet environment/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeDisabled();

    // "Portfolio" drops out of the compact single-line masthead nav below 860px (by design,
    // see `lib/nav.ts`'s `optional` flag) — current-route marking only applies where the link
    // is actually rendered there; the footer link is always reachable regardless of width.
    const mastheadLink = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Portfolio" });
    if (await mastheadLink.count()) {
      await expect(mastheadLink).toHaveAttribute("aria-current", "page");
    }
    await expect(page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Portfolio" })).toHaveAttribute(
      "href",
      "/portfolio",
    );

    expect(problems).toEqual([]);
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/portfolio");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/portfolio");
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/portfolio");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/portfolio-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/portfolio, unconfigured (no loans yet)", () => {
  test("prints an honest state instead of crashing", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`http://localhost:${UNCONFIGURED_PORT}/portfolio`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(problems).toEqual([]);
  });
});
