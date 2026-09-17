import { expect, test, type Page } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";

async function waitForPrint(page: Page) {
  await expect(page.locator("[data-printed]")).toHaveCount(2);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0),
  );
}

/** Scrolls the whole page the way a reader would, so scroll-triggered figures play. */
async function readThrough(page: Page) {
  const { height, step } = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    step: Math.round(window.innerHeight * 0.6),
  }));
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe("landing page", () => {
  test("renders every section without console errors", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });

    await page.goto("/");
    await expect(page).toHaveTitle("Advance");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Credit for agents that earn.");
    for (const name of [
      "How an advance moves from fee stream to noteholder",
      "The drain that bounced",
      "Your agent can apply on its own",
      "Buy a dollar of repayment for 84 cents",
      "Built on",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    await expect(page.getByRole("article", { name: /Revenue note/ })).toContainText("$241.80");
    await expect(page.getByRole("img", { name: "65 percent of the cap repaid over 23 sweeps" })).toBeVisible();
    await waitForPrint(page);
    await expect(page.locator("footer").getByText("Advance, issue 03.")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("sends every underwriting call to action to /underwrite", async ({ page }) => {
    await page.goto("/");
    const actions = page.getByRole("link", { name: "Underwrite an agent" });
    await expect(actions).toHaveCount(3);
    for (const link of await actions.all()) {
      await expect(link).toHaveAttribute("href", "/underwrite");
    }
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await waitForPrint(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("labels meaningful figures and hides decorative ones", async ({ page }) => {
    await page.goto("/");
    await waitForPrint(page);
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll("svg")]
        .filter((svg) => !svg.closest("[aria-hidden='true']"))
        .filter((svg) => !(svg.getAttribute("role") === "img" && svg.getAttribute("aria-label")))
        .map((svg) => svg.outerHTML.slice(0, 80)),
    );
    expect(unlabelled).toEqual([]);
    const imgsWithText = await page.evaluate(() =>
      [...document.querySelectorAll("img")].filter((img) => img.alt !== "").map((img) => img.src),
    );
    expect(imgsWithText).toEqual([]);
    await expect(page.getByRole("img", { name: /Halftone portrait of agent 0x3f2c/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /Halftone portrait of agent 0x9b07/ })).toBeAttached();
  });

  test("shows a visible focus ring on keyboard focus", async ({ page }) => {
    await page.goto("/");
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return { label: el.textContent?.trim() ?? "", outline: style.outlineStyle, width: style.outlineWidth };
      });
      expect(focus).not.toBeNull();
      expect(focus?.outline).not.toBe("none");
      expect(focus?.width).not.toBe("0px");
      seen.push(focus?.label ?? "");
    }
    expect(seen[0]).toBe("Skip to content");
    expect(seen).toContain("Underwrite an agent");
  });

  test("switches code galleys from the keyboard", async ({ page }) => {
    await page.goto("/");
    const mcp = page.getByRole("tab", { name: "MCP server" });
    const sdk = page.getByRole("tab", { name: "SDK" });
    const skill = page.getByRole("tab", { name: "Agent skill" });
    await mcp.focus();
    await expect(mcp).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText("get_credit_quote");

    await page.keyboard.press("ArrowRight");
    await expect(sdk).toBeFocused();
    await expect(sdk).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText('from "@advance/sdk"');

    await page.keyboard.press("End");
    await expect(skill).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(mcp).toHaveAttribute("aria-selected", "true");
    await expect(mcp).toHaveAttribute("tabindex", "0");
    await expect(sdk).toHaveAttribute("tabindex", "-1");
  });

  test("strikes the injected instruction once it scrolls into view", async ({ page }) => {
    await page.goto("/");
    const exhibit = page.locator("figure", { hasText: "Exhibit A. The instruction it found" });
    await expect(exhibit).not.toHaveAttribute("data-struck", "true");
    await exhibit.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    await expect(exhibit).toHaveAttribute("data-struck", "true");
  });

  test("opens a loupe over the hero portrait on hover", async ({ page, isMobile }) => {
    test.skip(isMobile, "touch screens have no hover");
    await page.goto("/");
    await waitForPrint(page);
    const portrait = page.getByRole("img", { name: /Halftone portrait of agent 0x3f2c/ });
    const box = await portrait.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) * 0.6, (box?.y ?? 0) + (box?.height ?? 0) * 0.5);
    await expect
      .poll(() => portrait.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--r")) || 0))
      .toBeGreaterThan(100);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/");
    await waitForPrint(page);
    await readThrough(page);
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/landing-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("with reduced motion", () => {
  test.use({ colorScheme: "light", reducedMotion: "reduce" });

  test("shows every figure in its final state without animating", async ({ page }) => {
    await page.goto("/");
    await waitForPrint(page);
    const exhibit = page.locator("figure", { hasText: "Exhibit A. The instruction it found" });
    await expect(exhibit).toHaveAttribute("data-struck", "true");
    const transitions = await page.evaluate(() =>
      [...document.querySelectorAll("img, span, svg, a")]
        .map((el) => getComputedStyle(el).transitionDuration)
        .filter((d) => d.split(",").some((part) => parseFloat(part) > 0)),
    );
    expect(transitions).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  });
});
