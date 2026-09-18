import type { Address, Hex } from "viem";
import type { LoanView } from "@advance/sdk";
import type { AgentEvent, MergedEvent } from "./events";
import { addressPrefix, isAddress, microUsdToUsd } from "./format";
import type { NoteTerms } from "./landing-data";

/**
 * Pure loan-page maths and event shaping shared by `/loans/[loanId]` — note terms, the draw
 * meter, the escrow harvest timeline, the card spend feed and status history. Every function
 * takes an already-fetched `LoanView`/event list, no I/O, so it's exercised directly with
 * fixtures in tests.
 */

// ---------------------------------------------------------------------------------------------
// Note terms
// ---------------------------------------------------------------------------------------------

export interface NoteTermsInput {
  clearingPriceCents: number;
  sweepsUsd: readonly number[];
  latestBlock: number;
}

/** The loan's `NoteTerms`, for the certificate — the same shape/derivation `getLandingData`
 * uses for its hero note, standalone so this page never depends on landing-only plumbing. */
export function noteTermsFromLoan(loan: LoanView, input: NoteTermsInput): NoteTerms {
  const capUsd = microUsdToUsd(loan.cap);
  const borrowedUsd = microUsdToUsd(loan.principal);
  const repaidUsd = microUsdToUsd(loan.repaid);
  return {
    agentLabel: addressPrefix(loan.termSheet.agentTreasury),
    series: addressPrefix(loan.termSheet.agentTreasury),
    notesOutstanding: capUsd, // 1 note == $1 of cap, by construction
    repaidPerNote: 1,
    clearingPriceCents: input.clearingPriceCents,
    capMultiple: borrowedUsd > 0 ? capUsd / borrowedUsd : 0,
    borrowedUsd,
    repaidUsd,
    capUsd,
    sweeps: input.sweepsUsd,
    latestBlock: input.latestBlock,
  };
}

// ---------------------------------------------------------------------------------------------
// Draw meter
// ---------------------------------------------------------------------------------------------

export interface DrawMeterData {
  limitUsd: number;
  usedUsd: number;
  availableUsd: number;
  periodLabel: string;
}

/** A human label for a draw period's length: `"day"` for exactly 86,400 seconds (read as a
 * bare noun, e.g. "$40/day"), otherwise `"N-hour period"`/`"N-minute period"`. Mirrors
 * `EligibleResult`'s own draw-period label, generalized for a period that isn't a whole
 * number of hours. */
export function drawPeriodLabel(seconds: bigint): string {
  const s = Number(seconds);
  if (s === 86_400) return "day";
  if (s > 0 && s % 3600 === 0) return `${Math.round(s / 3600)}-hour period`;
  if (s > 0 && s % 60 === 0) return `${Math.round(s / 60)}-minute period`;
  return `${s}-second period`;
}

/** Drawn vs. the credit line's per-period limit, from the loan's own on-chain state — no
 * separate chain read: `available` already is `creditLine.availableThisPeriod()`. */
export function drawMeterFromLoan(loan: LoanView): DrawMeterData {
  const limitUsd = microUsdToUsd(loan.termSheet.drawLimit);
  const availableUsd = microUsdToUsd(loan.available);
  const usedUsd = Math.max(0, limitUsd - availableUsd);
  return { limitUsd, usedUsd, availableUsd, periodLabel: drawPeriodLabel(loan.termSheet.drawPeriod) };
}

// ---------------------------------------------------------------------------------------------
// Escrow harvest timeline
// ---------------------------------------------------------------------------------------------

export interface HarvestEntry {
  id: string;
  timestamp: number;
  usdcOut: number;
  blockNumber: number;
  txHash: Hex;
}

/** Every `Harvested` sweep for this loan, oldest first — the same chronological order the
 * certificate's cap bar ticks read. */
export function harvestEntriesFromEvents(loan: LoanView, events: readonly MergedEvent[]): HarvestEntry[] {
  const loanIdStr = loan.loanId.toString();
  const entries: HarvestEntry[] = [];
  for (const event of events) {
    if (event.source !== "chain" || event.type !== "Harvested") continue;
    if (event.loanId === undefined || event.loanId.toString() !== loanIdStr) continue;
    entries.push({
      id: `${event.transactionHash}:${event.logIndex}`,
      timestamp: event.timestamp,
      usdcOut: microUsdToUsd(event.usdcOut),
      blockNumber: Number(event.blockNumber),
      txHash: event.transactionHash,
    });
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

/** Just the USD amounts, oldest first — the shape `Certificate`'s cap bar wants. */
export function sweepsUsdFromHarvests(harvests: readonly HarvestEntry[]): number[] {
  return harvests.map((h) => h.usdcOut);
}

// ---------------------------------------------------------------------------------------------
// Card spend feed — x402 receipts
// ---------------------------------------------------------------------------------------------

export interface CardReceipt {
  id: string;
  timestamp: number;
  payee: Address;
  /** Whole-USDC string as the runtime reported it, printed as-is rather than re-parsed —
   * `undefined` when the receipt didn't carry a readable amount. */
  amountUsdc?: string;
  txHash?: Hex;
}

/** Reads one `receipt` agent event into a `CardReceipt`. Tolerant of a couple of equivalent
 * field names for the payee/amount, matching `parseAgentEvent`'s own tolerance — `undefined`
 * for anything that isn't recognizably a receipt, never a row built from a guessed payee. */
export function toCardReceipt(event: AgentEvent): CardReceipt | undefined {
  if (event.type !== "receipt") return undefined;
  const payeeRaw = event.data.payee ?? event.data.to;
  if (typeof payeeRaw !== "string" || !isAddress(payeeRaw)) return undefined;

  const amountRaw = event.data.amount ?? event.data.amountUsdc ?? event.data.value;
  const amountUsdc = typeof amountRaw === "string" ? amountRaw : typeof amountRaw === "number" ? String(amountRaw) : undefined;

  return { id: event.id, timestamp: event.timestamp, payee: payeeRaw, amountUsdc, txHash: event.txHash };
}

/** Every readable `receipt` event, newest first. */
export function cardReceiptsFromEvents(events: readonly AgentEvent[]): CardReceipt[] {
  return events
    .map(toCardReceipt)
    .filter((r): r is CardReceipt => r !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp);
}

// ---------------------------------------------------------------------------------------------
// Status history
// ---------------------------------------------------------------------------------------------

export interface StatusHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  txHash?: Hex;
}

const LIFECYCLE_LABELS: Record<string, string> = {
  LoanOpened: "Auction opened",
  LoanActivated: "Auction graduated, loan active",
  LoanRepaid: "Cap repaid in full",
  LoanDefaulted: "Marked in default",
  LoanFailed: "Auction failed to graduate",
};

/** The loan's status history: always starts from the loan's own `openedAt`/`activatedAt` (so
 * it's never empty, even outside an events feed's lookback window), refined with real
 * transaction hashes from matching chain events when those are in range, plus any
 * `settlement_failed` off-chain events for this loan. Chronological, oldest first. */
export function statusHistoryFromEvents(loan: LoanView, events: readonly MergedEvent[]): StatusHistoryEntry[] {
  const loanIdStr = loan.loanId.toString();
  const entries = new Map<string, StatusHistoryEntry>();

  entries.set("LoanOpened", { id: "LoanOpened", label: LIFECYCLE_LABELS.LoanOpened ?? "Auction opened", timestamp: Number(loan.openedAt) });
  if (loan.activatedAt > 0n) {
    entries.set("LoanActivated", {
      id: "LoanActivated",
      label: LIFECYCLE_LABELS.LoanActivated ?? "Auction graduated, loan active",
      timestamp: Number(loan.activatedAt),
    });
  }

  for (const event of events) {
    if (event.source === "chain") {
      if (event.loanId === undefined || event.loanId.toString() !== loanIdStr) continue;
      const label = LIFECYCLE_LABELS[event.type];
      if (!label) continue;
      entries.set(event.type, { id: event.type, label, timestamp: event.timestamp, txHash: event.transactionHash });
    } else if (event.type === "settlement_failed" && event.loanId === loanIdStr) {
      entries.set(`settlement_failed:${event.id}`, { id: event.id, label: "Settlement failed", timestamp: event.timestamp, txHash: event.txHash });
    }
  }

  return [...entries.values()].sort((a, b) => a.timestamp - b.timestamp);
}
