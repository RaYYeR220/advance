import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/__screenshots__";
const UNCONFIGURED_PORT = Number(process.env.E2E_PORT ?? 3107);

test.describe("/loans/[loanId] — active loan with refusals across every layer", () => {
  test("shows the certificate, draw meter, harvests, card spend and every refusal layer", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/loans/2");
    await expect(page).toHaveTitle(/Loan #2/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Loan #2");
    await expect(page.getByRole("article", { name: /Revenue note/ })).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "Draw meter" })).toBeVisible();
    await expect(page.getByText("$25.00 drawn this day")).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "Escrow harvests" })).toBeVisible();
    await expect(page.getByText("$70.00")).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "Card spend" })).toBeVisible();
    await expect(page.getByText("2.40 USDC")).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "Refusal exhibits" })).toBeVisible();
    for (const title of ["Gateway precheck", "Card signature (ERC-1271)", "Credit line", "Wallet policy"]) {
      await expect(page.getByRole("heading", { level: 3, name: title })).toBeVisible();
    }
    await expect(page.getByText(/not on the card's allowlist/)).toBeVisible();
    await expect(page.getByRole("link", { name: "view tx" }).first()).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "ERC-8004 feedback" })).toBeVisible();
    await expect(page.getByText("No feedback posted yet.")).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "Status history" })).toBeVisible();
    await expect(page.getByText("Auction opened")).toBeVisible();
    await expect(page.getByText("Auction graduated, loan active")).toBeVisible();

    await expect(page.getByRole("link", { name: /The auction that priced this loan/ })).toHaveAttribute("href", "/auctions/2");

    expect(problems).toEqual([]);
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/loans/2");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("nests headings without skipping a level", async ({ page }) => {
    await page.goto("/loans/2");
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) => (i > 0 && level > (levels[i - 1] ?? 1) + 1 ? [i] : []));
    expect(skips).toEqual([]);
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/loans/2");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/loan-detail-active-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/loans/[loanId] — repaid loan, nothing ever refused", () => {
  test("shows honest empty states, never zeros pretending to be data", async ({ page }) => {
    await page.goto("/loans/3");
    await expect(page.getByText("Repaid", { exact: true })).toBeVisible();
    await expect(page.getByText("No card spend recorded yet.")).toBeVisible();
    const emptyLayers = page.getByText("No refusals recorded at this layer yet.");
    await expect(emptyLayers).toHaveCount(4);
  });

  test("renders the real posted ERC-8004 feedback instead of the empty state", async ({ page }) => {
    await page.goto("/loans/3");
    await expect(page.getByRole("heading", { level: 2, name: "ERC-8004 feedback" })).toBeVisible();
    await expect(page.getByText("No feedback posted yet.")).not.toBeVisible();
    await expect(page.getByText("+100", { exact: true })).toBeVisible();
    await expect(page.getByText(/repaid in full — tags advance \/ repaid, agent #3/)).toBeVisible();
    await expect(page.getByRole("link", { name: "view registry" })).toHaveAttribute(
      "href",
      "https://sepolia.basescan.org/address/0x8004b663056a597dffe9eccc1965a193b7388713",
    );
  });

  test("captures a full-page screenshot", async ({ page }, info) => {
    await page.goto("/loans/3");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/loan-detail-repaid-${info.project.name}.png`, fullPage: true });
  });
});

test.describe("/loans/[loanId] — not found / invalid", () => {
  test("an id that never opened a loan shows a plain not-found message, never a stack trace", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/loans/999");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("No loan #999 has opened");

    expect(problems).toEqual([]);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/at\s+\S+\.(ts|tsx|js):\d+/);
  });

  test("a non-numeric id shows an invalid-id message", async ({ page }) => {
    await page.goto("/loans/not-a-loan-id");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("doesn't look like a loan id");
  });
});

test.describe("/loans/[loanId], unconfigured (no loans yet)", () => {
  test("prints an honest state instead of crashing", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto(`http://localhost:${UNCONFIGURED_PORT}/loans/1`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(problems).toEqual([]);
  });
});
