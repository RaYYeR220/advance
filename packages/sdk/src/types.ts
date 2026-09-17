import type { Address, Hex } from "viem";
import type { Decision, EvidenceBundle, ScoreResult, TermSheet } from "@advance/core";

export type { Decision, EvidenceBundle, ScoreResult, TermSheet };

/** The one `Decision` variant `openLoan`/`prepareApplication` accept — a signed term sheet ready
 * to open a loan with. */
export type ApproveDecision = Extract<Decision, { kind: "approve" }>;

/** Mirrors `IAdvance.LoanStatus` (`contracts/src/interfaces/IAdvance.sol`) field-for-field, by
 * index, so a raw `uint8` read off the hub decodes into the same name the contract's NatSpec
 * uses. */
export const LOAN_STATUS_BY_INDEX = [
  "None",
  "Auction",
  "Active",
  "Repaid",
  "Defaulted",
  "Failed",
  "Aborted",
] as const;

export type LoanStatus = (typeof LOAN_STATUS_BY_INDEX)[number];

export function loanStatusFromIndex(index: number): LoanStatus {
  const status = LOAN_STATUS_BY_INDEX[index];
  if (status === undefined) {
    throw new Error(`unknown loan status index: ${index}`);
  }
  return status;
}

/** An unsigned transaction the caller signs and sends with their own wallet — the SDK never
 * holds keys, so this is as far as `prepareApplication` goes. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

/** A loan's full on-chain state, assembled from `AdvanceHub.loan(loanId)` plus its note, credit
 * line and escrow — every amount is USDC-wei (6 decimals) unless noted. */
export interface LoanView {
  loanId: bigint;
  status: LoanStatus;
  termSheet: TermSheet;
  escrow: Address;
  note: Address;
  creditLine: Address;
  auction: Address;
  /** `note.capUsdc()` — the note's total repayment cap. */
  cap: bigint;
  /** `note.totalRepaid()` — cumulative USDC distributed to the note so far. */
  repaid: bigint;
  /** `creditLine.principal()` — USDC the auction actually raised (0 until settled/graduated). */
  principal: bigint;
  /** `creditLine.totalDrawn()` — cumulative USDC drawn by the card. */
  drawn: bigint;
  /** `creditLine.availableThisPeriod()` — USDC still drawable in the current draw period. */
  available: bigint;
  /** `escrow.lastRevenueAt()` — unix seconds; 0 before activation. */
  lastRevenueAt: bigint;
  /** Unix seconds `openLoan` was called. */
  openedAt: bigint;
  /** Unix seconds the auction settled graduated; 0 until then. */
  activatedAt: bigint;
}

/** A loan's CCA note auction, read straight off the auction contract — no indexer. */
export interface AuctionView {
  /** The block the auction ends at. */
  endBlock: bigint;
  /** `max(0, endBlock - latest block)`. */
  blocksLeft: bigint;
  /** Whether the auction has raised at least `requiredCurrencyRaised`. Reflects the auction's
   * last checkpoint (see `ICCA.checkpoint`), which this read forces fresh via `eth_call`. */
  graduated: boolean;
  /** The currency being raised (the hub's USDC). */
  currency: Address;
  /** The auction's current clearing price, Q96 currency-wei per note-wei. */
  clearingPriceQ96: bigint;
  /** The term sheet's `minPrincipal` — the graduation threshold. */
  requiredCurrencyRaised: bigint;
  /** The auction contract's current currency balance — an honest proxy for "raised so far"
   * while the auction is live (real CCA auctions hold raised currency until `sweepCurrency`).
   * Reads 0 once the auction has settled and swept; see `LoanView.principal` for the final
   * settled amount at that point. */
  raisedSoFar: bigint;
}
