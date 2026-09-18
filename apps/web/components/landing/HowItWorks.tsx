import { FoldOut, annotationSerif, type FoldOutPanel } from "@/components/editorial/FoldOut";
import { RunningHead } from "@/components/editorial/Folio";
import { INK } from "@/components/halftone/screen";
import { cx } from "@/lib/cx";
import { formatCents, formatMultiple, formatUsd } from "@/lib/format";
import type { LandingData } from "@/lib/landing-data";
import styles from "./HowItWorks.module.css";

export interface HowItWorksProps {
  lifecycle: LandingData["lifecycle"];
}

const dashed = { stroke: INK.forest, strokeDasharray: "2 1.6" } as const;

/** The loan lifecycle as a five-panel gatefold, from underwriting to the final sweep. */
export function HowItWorks({ lifecycle }: HowItWorksProps) {
  const hasTerms = lifecycle.floorCents > 0;
  const floor = hasTerms ? formatCents(lifecycle.floorCents) : "a";
  const clearing = hasTerms ? formatCents(lifecycle.clearingPriceCents) : "—";
  const maxCap = hasTerms ? formatMultiple(100 / lifecycle.floorCents) : null;
  const dailyLimit = formatUsd(lifecycle.dailyLimitUsd);

  const panels: FoldOutPanel[] = [
    {
      scene: "underwrite",
      sceneLabel: `A magnifying glass reads the token's fee stream while a score sheet shows weekly fee bars and a score of ${lifecycle.score}`,
      annotations: (
        <>
          <circle cx="55" cy="18.5" r="7" fill={INK.stock} stroke={INK.forest} strokeWidth=".9" />
          <text className={annotationSerif} x="55" y="21" textAnchor="middle" fontSize="7.2">
            {lifecycle.score}
          </text>
          <text x="5" y="80.5">
            fee stream
          </text>
        </>
      ),
      title: "Underwrite",
      body: "Paste any Bankr token. The engine reads its fee history from archive nodes, scores it and signs a term sheet. The written memo can only tighten the terms.",
      call: "quote(token)",
    },
    {
      scene: "escrow",
      sceneLabel: "A vault sits on the fee stream, drawing fees in through a pipe",
      title: "Escrow",
      body: "The agent hands its token's fee rights to a RevenueEscrow contract. From here on, fees go where the contract says, not where the agent says.",
      call: "openLoan(termSheet)",
    },
    {
      scene: "auction",
      sceneLabel: hasTerms
        ? `A stepped clearing price rises block by block above an ${floor} floor, with filled bids above it`
        : "A stepped clearing price rises block by block above a floor, with filled bids above it",
      annotations: (
        <>
          <line x1="6" y1="64" x2="94" y2="64" strokeWidth=".9" {...dashed} />
          <text x="8" y="70.5">
            {floor} floor
          </text>
          <text x="92" y="70.5" textAnchor="end">
            one price per block
          </text>
          <text className={annotationSerif} x="93" y="31.5" textAnchor="end" fontSize="6">
            {clearing}
          </text>
        </>
      ),
      title: "Auction",
      body: maxCap
        ? `Notes sell in a Uniswap continuous clearing auction. One note is $1 of repayment, and the clearing price sets the principal. The ${floor} floor keeps the cap at ${maxCap}× or less.`
        : "Notes sell in a Uniswap continuous clearing auction. One note is $1 of repayment, and the clearing price sets the principal. A floor, set in the term sheet, keeps the cap bounded no matter how high the auction runs.",
      call: "bid(maxPrice, budget)",
    },
    {
      scene: "card",
      sceneLabel: "The agent's card above a week of draws, each stopped at the daily limit, with one oversized draw crossed out",
      annotations: (
        <>
          <line x1="12" y1="66" x2="88" y2="66" strokeWidth=".8" {...dashed} />
          <text x="12" y="63.4">
            {dailyLimit} a day
          </text>
          <text className={annotationSerif} x="77" y="57" fontSize="6">
            {formatUsd(lifecycle.blockedDrawUsd)}
          </text>
        </>
      ),
      title: "Card",
      body: "Proceeds sit in a CreditLine. Only the agent's card can draw, only up to its daily limit, and it can only pay allowlisted x402 services.",
      call: "draw(amount)",
    },
    {
      scene: "sweep",
      sceneLabel: "The fee stream fills three stacks of coins for noteholders up to a cap line, then flows back to the agent",
      annotations: (
        <>
          <line x1="16" y1="37" x2="74" y2="37" strokeWidth=".8" {...dashed} />
          <text x="17" y="34.4">
            cap
          </text>
          <path d="M72 30 C 74 20, 80 17, 84 18.5" fill="none" stroke={INK.forest} strokeWidth=".8" />
          <path d="M81.6 16.2 L84.6 18.6 L81.2 20.4" fill="none" stroke={INK.forest} strokeWidth=".8" />
          <text x="84" y="70" textAnchor="middle">
            back to agent
          </text>
        </>
      ),
      title: "Sweep",
      body: "A keeper calls sweep(). Fees convert to USDC and go to noteholders until the cap is repaid. Then fee rights return to the agent and the repayment lands on its ERC-8004 record.",
      call: "sweep(), then claim()",
    },
  ];

  return (
    <section className={cx("sec", styles.gatefold)} id="how" aria-labelledby="how-title">
      <RunningHead page={38} title="How it works" />
      <header className={styles.head}>
        <h2 className="h2-xl" id="how-title">
          How an advance moves from fee stream to noteholder
        </h2>
        <p className={cx("sec-deck", styles.deck)}>
          Nobody takes the agent&apos;s word for anything. Each step is a signed term sheet or a transaction you can look
          up on Basescan.
        </p>
      </header>
      <FoldOut panels={panels} />
      <p className={styles.foot}>
        <i>If the fees stop,</i> the loan is marked in default, undrawn credit goes to noteholders and the escrow keeps
        sweeping. Revenue-backed debt is never forgiven.
      </p>
    </section>
  );
}
