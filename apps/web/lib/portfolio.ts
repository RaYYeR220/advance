import type { Address, Hex } from "viem";
import type { LoanStatus, LoanView } from "@advance/sdk";
import type { ClaimedEvent, MergedEvent } from "./events";
import { microUsdToUsd } from "./format";
import type { JsonEventLike } from "./ticker";

/**
 * Pure `/portfolio` maths and shaping. Reading a connected lender's own note balances and
 * claimable USDC needs the wallet's own address, known only client-side once a wallet
 * connects — this module never reads chain state itself; it shapes whatever the client island
 * already read (see `components/wallet/portfolioSteps.ts`), so it's exercised directly with
 * fixtures in tests, the same split `loanDetail.ts`/`auctions.ts` use.
 */

/** One loan's revenue-note read for one holder address: `balanceOf` (notes held, 18-decimal
 * note-wei) and `claimable` (USDC owed, 6-decimal USDC-wei), paired with the loan it belongs
 * to. */
export interface NoteRead {
  loan: LoanView;
  balance: bigint;
  claimable: bigint;
}

export interface PortfolioRow {
  loanId: bigint;
  note: Address;
  agentTreasury: Address;
  status: LoanStatus;
  /** Notes held, in dollars — 1 note is worth exactly $1 of the loan's repayment cap by
   * construction (`noteSupply`/1e12 == `cap` in USDC-wei), so a note-wei balance converts the
   * same way USDC-wei does. */
  notesUsd: number;
  claimableUsd: number;
}

const NOTE_WEI_PER_DOLLAR = 1e18;

/** A note-wei balance, in dollars. */
export function notesToUsd(balanceNoteWei: bigint): number {
  return Number(balanceNoteWei) / NOTE_WEI_PER_DOLLAR;
}

/** Every loan where this wallet holds a note balance and/or has something claimable — the
 * loans it actually has a stake in, out of every loan the hub has ever opened. A loan with
 * both zero is dropped: never a row of two zeros standing in for "nothing here". Sorted by
 * claimable USDC descending, ties by notes held descending. */
export function portfolioRowsFromReads(reads: readonly NoteRead[]): PortfolioRow[] {
  return reads
    .filter((r) => r.balance > 0n || r.claimable > 0n)
    .map((r) => ({
      loanId: r.loan.loanId,
      note: r.loan.note,
      agentTreasury: r.loan.termSheet.agentTreasury,
      status: r.loan.status,
      notesUsd: notesToUsd(r.balance),
      claimableUsd: microUsdToUsd(r.claimable),
    }))
    .sort((a, b) => b.claimableUsd - a.claimableUsd || b.notesUsd - a.notesUsd);
}

/** The sum of every row's claimable USDC — the headline figure above the table. */
export function totalClaimableUsd(rows: readonly PortfolioRow[]): number {
  return rows.reduce((sum, r) => sum + r.claimableUsd, 0);
}

export interface RepaymentHistoryEntry {
  id: string;
  loanId: bigint;
  amountUsd: number;
  timestamp: number;
  txHash: Hex;
}

function isClaimedEvent(e: MergedEvent): e is ClaimedEvent {
  return e.source === "chain" && e.type === "Claimed";
}

/**
 * This wallet's own `Claimed` events, newest first — the repayment history table. There is no
 * indexer to enumerate every loan a lender ever held notes in without iterating every loan's
 * own contract one at a time (the same honest limitation `BidLadder` documents for a CCA's bid
 * book): `events` should be the merged activity of the loans `portfolioRowsFromReads` found
 * this wallet currently has a stake in, not a claim of "every claim this wallet ever made".
 */
export function claimHistoryFromEvents(events: readonly MergedEvent[], holder: Address): RepaymentHistoryEntry[] {
  const holderLower = holder.toLowerCase();
  return events
    .filter(isClaimedEvent)
    .filter((e) => e.holder.toLowerCase() === holderLower && e.loanId !== undefined)
    .map((e) => ({
      id: `${e.transactionHash}:${e.logIndex}`,
      loanId: e.loanId as bigint,
      amountUsd: microUsdToUsd(e.amount),
      timestamp: e.timestamp,
      txHash: e.transactionHash,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Same as `claimHistoryFromEvents`, over the JSON-safe shape `/api/events` actually returns
 * (every bigint a decimal string) — what the client island calls after fetching a connected
 * wallet's own loan activity, since that never goes through this app's own server-side data
 * layer. */
export function claimHistoryFromJsonEvents(events: readonly JsonEventLike[], holder: Address): RepaymentHistoryEntry[] {
  const holderLower = holder.toLowerCase();
  return events
    .filter((e) => e.source === "chain" && e.type === "Claimed")
    .filter((e) => typeof e.holder === "string" && (e.holder as string).toLowerCase() === holderLower)
    .filter((e): e is JsonEventLike & { loanId: string; transactionHash: string; logIndex: number; amount: string | number } =>
      e.loanId !== undefined && typeof e.transactionHash === "string" && typeof e.logIndex === "number",
    )
    .map((e) => ({
      id: `${e.transactionHash}:${e.logIndex}`,
      loanId: BigInt(e.loanId),
      amountUsd: Number(e.amount ?? 0) / 1_000_000,
      timestamp: e.timestamp,
      txHash: e.transactionHash as Hex,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}
