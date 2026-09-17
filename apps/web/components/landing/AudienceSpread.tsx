import { ButtonLink, TextLink } from "@/components/editorial/Action";
import { RunningHead } from "@/components/editorial/Folio";
import { PullQuote } from "@/components/editorial/PullQuote";
import { AuctionChart } from "@/components/halftone/AuctionChart";
import { INK } from "@/components/halftone/screen";
import { clearingPriceAt } from "@/components/halftone/charts";
import { cx } from "@/lib/cx";
import { addressPrefix, formatCents, formatInteger, formatUsd, shortAddress } from "@/lib/format";
import type { LandingData } from "@/lib/landing-data";
import { ApplyTabs, type ApplyTab } from "./ApplyTabs";
import styles from "./AudienceSpread.module.css";

export interface AudienceSpreadProps {
  audiences: LandingData["audiences"];
}

/** Facing pages for the two sides of a loan: agents applying on the left, lenders bidding on the right. */
export function AudienceSpread({ audiences }: AudienceSpreadProps) {
  const { quote, memo, auction } = audiences;
  const token = shortAddress(audiences.token);
  const series = addressPrefix(audiences.token);
  const limit = formatUsd(quote.dailyLimitUsd);
  const clearingCents = clearingPriceAt(auction.steps, auction.blocks - 1);

  const tabs: ApplyTab[] = [
    {
      id: "mcp",
      label: "MCP server",
      lines: [
        { text: "// from any MCP client or a Bankr agent's loop", comment: true },
        { text: `get_credit_quote({ token: "${token}" })` },
        { text: `// score ${quote.score}, up to ${formatUsd(quote.maxUsd)}, ${limit} a day`, comment: true },
        { text: " " },
        { text: `apply_for_advance({ token: "${token}" })` },
        { text: `// escrow set, ${formatInteger(quote.notes)} notes in auction`, comment: true },
        { text: " " },
        { text: `draw_credit({ amount: ${quote.dailyLimitUsd} })`, stress: String(quote.dailyLimitUsd) },
        { text: "pay_x402({ url: gateway, maxUsd: 0.25 })" },
      ],
      notes: [
        { line: 3, text: "a signed term sheet" },
        { line: 8, text: `anything over ${limit} reverts` },
      ],
    },
    {
      id: "sdk",
      label: "SDK",
      lines: [
        { text: 'import { quote, openLoan, card } from "@advance/sdk";' },
        { text: " " },
        { text: `const terms = await quote("${token}");` },
        { text: 'if (terms.decision === "approve") {' },
        { text: "  await openLoan(terms);" },
        { text: "}" },
        { text: " " },
        { text: "// spend only through the card", comment: true },
        { text: "await card.fetch(gatewayUrl, request);" },
      ],
      notes: [
        { line: 3, text: "EIP-712, verifiable" },
        { line: 9, text: "pays over x402" },
      ],
    },
    {
      id: "skill",
      label: "Agent skill",
      lines: [
        { text: "---", comment: true },
        { text: "name: advance" },
        { text: "description: Borrow against your token's fees" },
        { text: "---", comment: true },
        { text: "When runway drops under 14 days:" },
        { text: "1. get_credit_quote for your own token" },
        { text: "2. If approved, apply_for_advance" },
        { text: "3. Pay services from the card," },
        { text: "   never from the treasury" },
      ],
      notes: [
        { line: 5, text: "no human needed" },
        { line: 8, text: "off-list payees refused" },
      ],
    },
  ];

  return (
    <section className="sec spread" id="docs" aria-label="For agents and for lenders">
      <div className="gutter" aria-hidden="true" />
      <div className="pg pg-l">
        <RunningHead page={46} title="For agents" />
        <h2 className={cx("h2-l", styles.title)}>Your agent can apply on its own</h2>
        <p className={cx("prose", styles.intro)}>
          No forms and no human in the loop. The same calls work from any MCP client, the TypeScript SDK or the Bankr
          skill.
        </p>
        <ApplyTabs label="Ways to apply" tabs={tabs} />
        <PullQuote
          variant="memo"
          attribution={`From the underwriting memo for ${series}. A memo can tighten the terms a formula allows. It can never loosen them.`}
        >
          Fees have grown four weeks in a row, mostly from organic volume. One pool carries {memo.largestPoolSharePct}% of
          it, so the daily draw limit is {limit} rather than {formatUsd(memo.formulaLimitUsd)}.
        </PullQuote>
        <div className={styles.cta}>
          <ButtonLink href="/underwrite" prefetch={false}>Underwrite an agent</ButtonLink>
          <TextLink href="#docs">Read the docs</TextLink>
        </div>
      </div>

      <div className="pg pg-r" id="auctions">
        <RunningHead page={47} title="For lenders" side="right" />
        <h2 className={cx("h2-l", styles.title)}>
          Buy a dollar of repayment for {clearingCents} cents
        </h2>
        <p className={cx("prose", styles.intro)}>
          Bid USDC in the auction. Each sweep sends fees to noteholders, and you claim your share whenever you like. If
          the agent stops earning, the note stops paying and the default goes on its public record.
        </p>
        <AuctionChart
          startBlock={auction.startBlock}
          blocks={auction.blocks}
          floorCents={auction.floorCents}
          steps={auction.steps}
          bid={auction.bid}
          caption={`Auction for notes of agent ${series}. One price per block, and everyone who clears pays the same.`}
        />
        <div className={styles.coupon} id="portfolio">
          <svg className={styles.scissors} viewBox="0 0 30 24" aria-hidden="true">
            <circle cx="6" cy="6" r="4" fill="none" stroke={INK.forest} strokeWidth="1.6" />
            <circle cx="6" cy="18" r="4" fill="none" stroke={INK.forest} strokeWidth="1.6" />
            <path d="M9 8 L28 18 M9 16 L28 6" stroke={INK.forest} strokeWidth="1.6" />
          </svg>
          <h3>Your bid slip</h3>
          <dl>
            <dt>Series</dt>
            <dd>{series}</dd>
            <dt>Max price</dt>
            <dd>{formatCents(auction.bid.maxPriceCents)}</dd>
            <dt>Budget</dt>
            <dd>{formatInteger(auction.bid.budgetUsdc)} USDC</dd>
            <dt>Filled</dt>
            <dd>
              {formatInteger(auction.bid.filledNotes)} notes at {formatCents(clearingCents)}
            </dd>
          </dl>
          <p className={styles.claim}>
            <b>{formatUsd(auction.bid.claimableUsd, { cents: true })}</b>
            <span>ready to claim</span>
          </p>
        </div>
        <p className={styles.cta}>
          <TextLink href="#auctions">Browse open auctions</TextLink>
        </p>
      </div>
    </section>
  );
}
