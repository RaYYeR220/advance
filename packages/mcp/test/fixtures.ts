import type { Address, Hex, WalletClient } from "viem";
import { centsToQ96, type ApproveDecision, type LoanView, type ScoreResult, type TermSheet } from "@advance/sdk";
import type { AdvanceOperations } from "../src/types.js";

function addr(digit: string): Address {
  return `0x${digit.repeat(40)}` as Address;
}

function hash(digit: string): Hex {
  return `0x${digit.repeat(64)}` as Hex;
}

/** A well-formed 65-byte ECDSA signature (130 hex chars) — real `signTypedData` output length,
 * which `ApproveDecisionInputSchema` now checks. */
function signature(digit: string): Hex {
  return `0x${digit.repeat(130)}` as Hex;
}

export const TOKEN: Address = addr("1");
export const AGENT_CARD: Address = addr("2");
export const AGENT_TREASURY: Address = addr("3");
export const HUB: Address = addr("4");
export const ESCROW: Address = addr("5");
export const NOTE: Address = addr("6");
export const CREDIT_LINE: Address = addr("7");
export const AUCTION: Address = addr("8");
export const FEES_MANAGER: Address = addr("9");
export const TX_HASH: Hex = hash("a");
export const MEMO_HASH: Hex = hash("b");
export const SIGNATURE: Hex = signature("d");

export const SAMPLE_TERM_SHEET: TermSheet = {
  agentTreasury: AGENT_TREASURY,
  agentCard: AGENT_CARD,
  agentId: 0n,
  feesManager: FEES_MANAGER,
  poolId: MEMO_HASH,
  expectedShares: 950000000000000000n,
  noteSupply: 10_000_000_000_000_000_000n,
  floorCents: 80,
  minPrincipal: 1_000_000n,
  auctionBlocks: 250n,
  drawLimit: 500_000n,
  drawPeriod: 86_400n,
  gracePeriod: 1_209_600n,
  deadline: 9_999_999_999n,
  nonce: 1n,
  memoHash: MEMO_HASH,
};

export const SAMPLE_APPROVE_DECISION: ApproveDecision = {
  kind: "approve",
  token: TOKEN,
  termSheet: SAMPLE_TERM_SHEET,
  signature: SIGNATURE,
  digest: MEMO_HASH,
  terms: {
    revenueWei: { d1: 0n, d7: 0n, d30: 0n },
    revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n },
    projected90dMicroUsd: 0n,
    haircutBps: 0,
    capMicroUsd: 10_000_000n,
    floorCents: 80,
    minPrincipal: 1_000_000n,
    drawLimit: 500_000n,
    drawPeriod: 86_400,
    gracePeriod: 1_209_600,
  },
  memo: { verdict: "approve", capMultiplierBps: 10000, floorCentsDelta: 0, rationale: "test", risks: [] },
  evidenceHash: MEMO_HASH,
  evidence: {} as never,
};

export const SAMPLE_LOAN_VIEW: LoanView = {
  loanId: 1n,
  status: "Auction",
  termSheet: SAMPLE_TERM_SHEET,
  escrow: ESCROW,
  note: NOTE,
  creditLine: CREDIT_LINE,
  auction: AUCTION,
  cap: 10_000_000n,
  repaid: 0n,
  principal: 0n,
  drawn: 0n,
  available: 0n,
  lastRevenueAt: 0n,
  openedAt: 1_700_000_000n,
  activatedAt: 0n,
};

export const SAMPLE_SCORE_RESULT: ScoreResult = {
  kind: "eligible",
  token: TOKEN,
  terms: {
    revenueWei: { d1: 0n, d7: 0n, d30: 0n },
    revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n },
    projected90dMicroUsd: 0n,
    haircutBps: 0,
    capMicroUsd: 10_000_000n,
    floorCents: 80,
    minPrincipal: 1_000_000n,
    drawLimit: 500_000n,
    drawPeriod: 86_400,
    gracePeriod: 1_209_600,
    noteSupply: 10_000_000_000_000_000_000n,
    auctionBlocks: 250n,
  },
  evidenceHash: MEMO_HASH,
  evidence: {} as never,
};

/** A stub `AdvanceOperations`: every method returns a canned value and records its call args, so
 * a test can both assert on tool output and on what the tool actually asked the client to do —
 * without a network, an RPC endpoint, or a chain. */
export function createFakeAdvanceOperations(): AdvanceOperations & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };

  return {
    calls,
    async score(token) {
      record("score", [token]);
      return SAMPLE_SCORE_RESULT;
    },
    async quote(req) {
      record("quote", [req]);
      return SAMPLE_APPROVE_DECISION;
    },
    async evidence(hash) {
      record("evidence", [hash]);
      return {} as never;
    },
    async predictEscrow(ts) {
      record("predictEscrow", [ts]);
      return ESCROW;
    },
    prepareApplication(decision) {
      record("prepareApplication", [decision]);
      return {
        moveBeneficiary: { to: FEES_MANAGER, data: "0x" as Hex, value: 0n },
        openLoan: { to: HUB, data: "0x" as Hex, value: 0n },
      };
    },
    async openLoan(wallet, decision) {
      record("openLoan", [wallet, decision]);
      return { hash: TX_HASH, loanId: 1n };
    },
    async loan(loanId) {
      record("loan", [loanId]);
      return SAMPLE_LOAN_VIEW;
    },
    async loans(filter) {
      record("loans", [filter]);
      return [SAMPLE_LOAN_VIEW];
    },
    async auction(loanId) {
      record("auction", [loanId]);
      return {
        endBlock: 1_000_250n,
        blocksLeft: 100n,
        graduated: false,
        currency: addr("c"),
        clearingPriceQ96: centsToQ96(80),
        requiredCurrencyRaised: 1_000_000n,
        raisedSoFar: 500_000n,
      };
    },
    async bid(wallet, p) {
      record("bid", [wallet, p]);
      return { hash: TX_HASH, bidId: 1n };
    },
    async claim(wallet, loanId) {
      record("claim", [wallet, loanId]);
      return { hash: TX_HASH, amount: 100_000n };
    },
    async draw(wallet, p) {
      record("draw", [wallet, p]);
      return { hash: TX_HASH };
    },
    async sendPreparedTx(wallet, tx) {
      record("sendPreparedTx", [wallet, tx]);
      return { hash: TX_HASH };
    },
  };
}

export function fakeWallet(): WalletClient {
  return { account: { address: AGENT_TREASURY } } as unknown as WalletClient;
}
