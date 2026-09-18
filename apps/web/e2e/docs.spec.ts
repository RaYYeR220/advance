import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";

test.describe("/docs — quickstart and contract addresses", () => {
  test("shows the SDK/MCP/skill sections, both chains, and the record", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/docs");
    await expect(page).toHaveTitle(/Docs/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Point an agent at Advance");

    await expect(page.getByRole("heading", { level: 2, name: "SDK" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "MCP server" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Agent skill" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Contract addresses" })).toBeVisible();

    // Base Sepolia is deployed in this repository checkout; Base mainnet honestly isn't yet.
    await expect(page.getByText("Base Sepolia", { exact: true })).toBeVisible();
    await expect(page.getByText("Base mainnet", { exact: true })).toBeVisible();
    await expect(page.getByText("Not deployed", { exact: true })).toBeVisible();

    await expect(page.getByRole("link", { name: "Claims ledger" })).toHaveAttribute("href", "/docs/claims");
    // PROOF.md doesn't exist in this checkout yet — an honest "not published yet", not a dead link.
    await expect(page.getByText("Not published yet")).toBeVisible();

    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    expect(problems).toEqual([]);
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/docs");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/docs");
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/docs");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/docs-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/docs/[slug] — a real repository doc", () => {
  test("renders the claims ledger with its table and a link back", async ({ page }) => {
    await page.goto("/docs/claims");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Claims ledger");
    await expect(page.getByRole("heading", { level: 2, name: "Verified live" })).toBeVisible();
    await expect(page.getByRole("table").first()).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(2); // "Verified live" and "Reproducible"
    await expect(page.getByRole("link", { name: "Back to docs" })).toHaveAttribute("href", "/docs");
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/docs/claims");
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/docs/claims");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/docs-claims-${info.project.name}.png`, fullPage: true });
  });

  test("shows an honest not-published state for a doc that doesn't exist yet", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/docs/proof");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("isn't written yet");
    await expect(page.getByRole("link", { name: "Back to docs" })).toHaveAttribute("href", "/docs");

    expect(problems).toEqual([]);
  });

  test("shows the same honest state for an unrecognized slug", async ({ page }) => {
    await page.goto("/docs/not-a-real-doc");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("isn't written yet");
  });
});
