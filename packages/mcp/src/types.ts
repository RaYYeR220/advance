import type { Address, Hex, WalletClient } from "viem";
import type {
  ApproveDecision,
  AuctionView,
  Decision,
  EvidenceBundle,
  LoanStatus,
  LoanView,
  ScoreResult,
  TermSheet,
  TxRequest,
} from "@advance/sdk";

/**
 * The exact slice of `AdvanceClient`'s public surface these tools call. Depending on this
 * interface rather than the concrete class keeps every tool testable with a plain object —
 * `@advance/sdk`'s `AdvanceClient` satisfies it structurally, so the real client needs no
 * wrapping in production, and tests substitute a fake without touching a network or chain.
 */
export interface AdvanceOperations {
  score(token: Address): Promise<ScoreResult>;
  quote(req: { token: Address; agentCard: Address; agentId: bigint }): Promise<Decision>;
  evidence(hash: Hex): Promise<EvidenceBundle>;
  predictEscrow(ts: TermSheet): Promise<Address>;
  prepareApplication(decision: ApproveDecision): { moveBeneficiary: TxRequest; openLoan: TxRequest };
  openLoan(wallet: WalletClient, decision: ApproveDecision): Promise<{ hash: Hex; loanId: bigint }>;
  loan(loanId: bigint): Promise<LoanView>;
  loans(filter?: { status?: LoanStatus; agent?: Address }): Promise<LoanView[]>;
  auction(loanId: bigint): Promise<AuctionView>;
  bid(
    wallet: WalletClient,
    p: { loanId: bigint; notes: bigint; maxPriceCents: number },
  ): Promise<{ hash: Hex; bidId: bigint }>;
  claim(wallet: WalletClient, loanId: bigint): Promise<{ hash: Hex; amount: bigint }>;
  draw(wallet: WalletClient, p: { card: Address; loanId: bigint; amount: bigint }): Promise<{ hash: Hex }>;
  /** Sends an arbitrary prepared transaction (e.g. `prepareApplication().moveBeneficiary`) with
   * `wallet` and waits for it to be mined. Not on `AdvanceClient` itself — the tools need it to
   * drive `advance_apply`'s two-step application without hand-rolling `sendTransaction` here. */
  sendPreparedTx(wallet: WalletClient, tx: TxRequest): Promise<{ hash: Hex }>;
}

/** Resolves the wallet a write tool signs with, or `undefined` when no signer is configured —
 * the injection point `ADVANCE_SIGNER` is built from by default (a private key for local dev),
 * and what an agent runtime replaces with a Dynamic-managed MPC signer. Called fresh on every
 * write-tool invocation rather than cached once, so a runtime backing it with a rotating or
 * per-call key never has to restart this server to pick up a change. */
export type SignerResolver = () => Promise<WalletClient | undefined>;
