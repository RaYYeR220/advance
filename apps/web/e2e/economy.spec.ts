import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";
const UNCONFIGURED_PORT = Number(process.env.E2E_PORT ?? 3107);

test.describe("/economy — every funded agent", () => {
  test("shows each agent's card, its status and the live activity ticker", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/economy");
    await expect(page).toHaveTitle(/Economy/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("The whole book, agent by agent");

    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Repaid", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("$225.00")).toBeVisible(); // loan 2's real 7-day harvested revenue

    await expect(page.getByRole("heading", { level: 2, name: "Live activity" })).toBeVisible();

    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Economy" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    expect(problems).toEqual([]);
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/economy");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/economy");
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/economy");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/economy-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/economy, unconfigured (no loans yet)", () => {
  test("prints an honest empty state instead of crashing", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`http://localhost:${UNCONFIGURED_PORT}/economy`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/hasn't funded its first agent yet/)).toBeVisible();

    expect(problems).toEqual([]);
  });
});
