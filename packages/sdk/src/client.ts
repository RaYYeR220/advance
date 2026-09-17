import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { termSheetStructHash, type SupportedChainId, type TermSheet } from "@advance/core";
import { fetchEvidence, fetchQuote, fetchScore, type ApiClientOptions } from "./api.js";
import {
  encodeMoveBeneficiaryTx,
  encodeOpenLoanTx,
  readAuction,
  readLoan,
  readLoans,
  readPredictEscrow,
  writeBid,
  writeClaim,
  writeDraw,
  writeOpenLoan,
  type ChainContext,
} from "./contracts.js";
import type {
  ApproveDecision,
  AuctionView,
  Decision,
  EvidenceBundle,
  LoanStatus,
  LoanView,
  ScoreResult,
  TxRequest,
} from "./types.js";

export interface AdvanceClientOptions {
  chainId: SupportedChainId;
  /** Base URL of the underwriter API (no trailing slash). */
  apiUrl: string;
  publicClient: PublicClient;
  hub: Address;
  /** x402-aware `fetch` used for the paid `quote()` call. Plain `fetch` when omitted. */
  paymentFetch?: typeof fetch;
}

/**
 * Typed client for the Advance protocol: score a token, get a signed quote, open a loan, bid on
 * its note, draw credit and claim repayments. Holds no keys — every write takes a viem
 * `WalletClient` from the caller.
 */
export class AdvanceClient {
  readonly chainId: SupportedChainId;
  readonly hub: Address;
  readonly publicClient: PublicClient;

  private readonly apiOptions: ApiClientOptions;
  private readonly chainContext: ChainContext;
  /** `predictEscrow`'s last result per term sheet (keyed by its EIP-712 struct hash), so the
   * synchronous `prepareApplication` can build `moveBeneficiary` without its own chain read. */
  private readonly predictedEscrows = new Map<Hex, Address>();

  constructor(opts: AdvanceClientOptions) {
    this.chainId = opts.chainId;
    this.hub = opts.hub;
    this.publicClient = opts.publicClient;
    this.apiOptions = { apiUrl: opts.apiUrl, paymentFetch: opts.paymentFetch };
    this.chainContext = { publicClient: opts.publicClient, hub: opts.hub };
  }

  /** `GET /v1/score/:token` — free eligibility check (terms + hard rules only). */
  async score(token: Address): Promise<ScoreResult> {
    return fetchScore(this.apiOptions, token);
  }

  /** `POST /v1/quote` — the paid path: a full engine run, a signed `TermSheet` on approval. Uses
   * `paymentFetch` if the client was constructed with one. */
  async quote(req: { token: Address; agentCard: Address; agentId: bigint }): Promise<Decision> {
    return fetchQuote(this.apiOptions, { ...req, chainId: this.chainId });
  }

  /** `GET /v1/evidence/:hash` — the canonical bundle a decision's `evidenceHash` was computed from. */
  async evidence(hash: Hex): Promise<EvidenceBundle> {
    return fetchEvidence(this.apiOptions, hash);
  }

  /** The escrow address `openLoan` would deploy for `ts` (`AdvanceHub.predictEscrow`). Call this
   * before `prepareApplication` for the same term sheet — its result is cached here and is what
   * `prepareApplication`'s `moveBeneficiary` tx targets. */
  async predictEscrow(ts: TermSheet): Promise<Address> {
    const escrow = await readPredictEscrow(this.chainContext, ts);
    this.predictedEscrows.set(termSheetStructHash(ts), escrow);
    return escrow;
  }

  /**
   * Builds the two unsigned transactions an approved application needs: pointing the term
   * sheet's Doppler fee-beneficiary shares at its escrow, then `openLoan` itself. Pure and
   * synchronous — requires `predictEscrow(decision.termSheet)` to have already been called (so
   * the escrow address is known without this method making its own chain read).
   */
  prepareApplication(decision: ApproveDecision): { moveBeneficiary: TxRequest; openLoan: TxRequest } {
    const escrow = this.predictedEscrows.get(termSheetStructHash(decision.termSheet));
    if (!escrow) {
      throw new Error(
        "advance sdk: prepareApplication needs the escrow address — call predictEscrow(decision.termSheet) first",
      );
    }
    return {
      moveBeneficiary: encodeMoveBeneficiaryTx(escrow, decision),
      openLoan: encodeOpenLoanTx(this.hub, decision),
    };
  }

  /** Sends `openLoan` with `wallet` (must be the term sheet's `agentTreasury`). */
  async openLoan(wallet: WalletClient, decision: ApproveDecision): Promise<{ hash: Hex; loanId: bigint }> {
    return writeOpenLoan(wallet, this.chainContext, decision);
  }

  /** A loan's full on-chain state — status, cap, repaid, principal, drawn, available, its
   * contracts, and its escrow's `lastRevenueAt`. */
  async loan(loanId: bigint): Promise<LoanView> {
    return readLoan(this.chainContext, loanId);
  }

  /** Every loan the hub has opened, optionally filtered by status and/or borrower. No indexer:
   * reads `loanCount` then every `loan(id)` directly off the hub. */
  async loans(filter?: { status?: LoanStatus; agent?: Address }): Promise<LoanView[]> {
    return readLoans(this.chainContext, filter);
  }

  /** A loan's CCA note auction: clearing price, currency raised so far, blocks left, graduated. */
  async auction(loanId: bigint): Promise<AuctionView> {
    return readAuction(this.chainContext, loanId);
  }

  /** Bids `notes` notes up to `maxPriceCents` on `loanId`'s auction: `USDC.approve(Permit2)`,
   * `Permit2.approve(USDC, auction, ...)`, then `submitBid`. */
  async bid(
    wallet: WalletClient,
    p: { loanId: bigint; notes: bigint; maxPriceCents: number },
  ): Promise<{ hash: Hex; bidId: bigint }> {
    return writeBid(wallet, this.chainContext, p);
  }

  /** Claims the caller's owed USDC from `loanId`'s revenue note. */
  async claim(wallet: WalletClient, loanId: bigint): Promise<{ hash: Hex; amount: bigint }> {
    return writeClaim(wallet, this.chainContext, loanId);
  }

  /** Draws `amount` USDC from `loanId`'s credit line into `card` (must be called with the
   * card owner's wallet). */
  async draw(wallet: WalletClient, p: { card: Address; loanId: bigint; amount: bigint }): Promise<{ hash: Hex }> {
    return writeDraw(wallet, this.chainContext, p);
  }
}
