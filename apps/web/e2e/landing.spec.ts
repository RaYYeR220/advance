import { expect, test, type Page } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";

/** Waits for every screened image (the fold-out scenes; no portraits print when the page has
 * no funded agent) to finish loading, so a screenshot never catches a half-drawn figure. */
async function waitForImages(page: Page) {
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

// This project's server runs with no `ADVANCE_HUB` configured — the real pre-launch state, and
// exactly the case `getLandingDataSafe` must degrade gracefully from: no crash, an honest "no
// loans yet" page, still laid out and still readable.
test.describe("landing page, unconfigured (no loans yet)", () => {
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
      "Two locks, waiting",
      "Your agent can apply on its own",
      "No auction open right now",
      "Built on",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    await expect(page.getByRole("article", { name: /Revenue note/ })).toContainText("Not issued yet");
    await expect(page.getByText("No loan open yet")).toBeVisible();
    await expect(page.getByText("Advance hasn't funded its first agent yet")).toBeVisible();
    await waitForImages(page);
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
    await waitForImages(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("never prints a fabricated non-zero figure for terms nothing has set yet", async ({ page }) => {
    await page.goto("/");
    await waitForImages(page);
    // The certificate and hero panel must not claim a specific cap/multiple/price that no loan
    // has actually set.
    await expect(page.getByText("0.00×")).toHaveCount(0);
    await expect(page.getByText("$0.00", { exact: false })).toHaveCount(0);
  });

  test("labels meaningful figures and hides decorative ones", async ({ page }) => {
    await page.goto("/");
    await waitForImages(page);
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
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/");
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))),
    );
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("sets lifecycle step numbers in readable ochre ink", async ({ page }) => {
    await page.goto("/");
    const colors = await page
      .locator("#how ol > li h3")
      .evaluateAll((titles) => titles.map((t) => getComputedStyle(t.previousElementSibling as Element).color));
    expect(colors).toEqual(Array(5).fill("rgb(163, 117, 33)"));
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

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/");
    await waitForImages(page);
    await readThrough(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/landing-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("with reduced motion", () => {
  test.use({ colorScheme: "light", reducedMotion: "reduce" });

  test("respects prefers-reduced-motion", async ({ page }) => {
    await page.goto("/");
    await waitForImages(page);
    const transitions = await page.evaluate(() =>
      [...document.querySelectorAll("img, span, svg, a")]
        .map((el) => getComputedStyle(el).transitionDuration)
        .filter((d) => d.split(",").some((part) => parseFloat(part) > 0)),
    );
    expect(transitions).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  });
});
