import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { LoanView, TermSheet } from "@advance/sdk";
import type { ClaimedEvent, MergedEvent } from "@/lib/events";
import type { JsonEventLike } from "@/lib/ticker";
import {
  claimHistoryFromEvents,
  claimHistoryFromJsonEvents,
  notesToUsd,
  portfolioRowsFromReads,
  totalClaimableUsd,
  type NoteRead,
} from "@/lib/portfolio";

const AGENT: Address = "0x1111111111111111111111111111111111111111";
const LENDER: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOTE_1: Address = "0x6666666666666666666666666666666666666666";
const NOTE_2: Address = "0x6666666666666666666666666666666666666667";

function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function fakeTermSheet(): TermSheet {
  return {
    agentTreasury: AGENT,
    agentCard: AGENT,
    agentId: 0n,
    feesManager: AGENT,
    poolId: `0x${"1".repeat(64)}` as Hex,
    expectedShares: 950_000_000_000_000_000n,
    noteSupply: 0n,
    floorCents: 80,
    minPrincipal: 0n,
    auctionBlocks: 0n,
    drawLimit: 0n,
    drawPeriod: 86_400n,
    gracePeriod: 14n * 86_400n,
    deadline: 4_000_000_000n,
    nonce: 1n,
    memoHash: `0x${"a".repeat(64)}` as Hex,
  };
}

function fakeLoan(overrides: Partial<LoanView> = {}): LoanView {
  return {
    loanId: 1n,
    status: "Active",
    termSheet: fakeTermSheet(),
    escrow: AGENT,
    note: NOTE_1,
    creditLine: AGENT,
    auction: AGENT,
    cap: 500_000_000n,
    repaid: 0n,
    principal: 0n,
    drawn: 0n,
    available: 0n,
    lastRevenueAt: 0n,
    openedAt: 0n,
    activatedAt: 0n,
    ...overrides,
  };
}

describe("notesToUsd", () => {
  it("converts 18-decimal note-wei to dollars, 1 note == $1", () => {
    expect(notesToUsd(250_000_000_000_000_000_000n)).toBe(250);
    expect(notesToUsd(0n)).toBe(0);
  });
});

describe("portfolioRowsFromReads", () => {
  it("drops loans with both zero balance and zero claimable", () => {
    const reads: NoteRead[] = [
      { loan: fakeLoan({ loanId: 1n }), balance: 0n, claimable: 0n },
      { loan: fakeLoan({ loanId: 2n, note: NOTE_2 }), balance: 100_000_000_000_000_000_000n, claimable: 5_000_000n },
    ];
    const rows = portfolioRowsFromReads(reads);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.loanId).toBe(2n);
    expect(rows[0]?.notesUsd).toBe(100);
    expect(rows[0]?.claimableUsd).toBe(5);
  });

  it("keeps a row with claimable but no remaining balance (fully sold, not yet claimed)", () => {
    const reads: NoteRead[] = [{ loan: fakeLoan({ loanId: 3n }), balance: 0n, claimable: 12_500_000n }];
    const rows = portfolioRowsFromReads(reads);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notesUsd).toBe(0);
    expect(rows[0]?.claimableUsd).toBe(12.5);
  });

  it("sorts by claimable USDC descending, ties by notes held descending", () => {
    const reads: NoteRead[] = [
      { loan: fakeLoan({ loanId: 1n }), balance: 10_000_000_000_000_000_000n, claimable: 1_000_000n },
      { loan: fakeLoan({ loanId: 2n, note: NOTE_2 }), balance: 50_000_000_000_000_000_000n, claimable: 9_000_000n },
      { loan: fakeLoan({ loanId: 3n }), balance: 200_000_000_000_000_000_000n, claimable: 1_000_000n },
    ];
    const rows = portfolioRowsFromReads(reads);
    expect(rows.map((r) => r.loanId)).toEqual([2n, 3n, 1n]);
  });
});

describe("totalClaimableUsd", () => {
  it("sums every row's claimable amount", () => {
    const rows = portfolioRowsFromReads([
      { loan: fakeLoan({ loanId: 1n }), balance: 0n, claimable: 3_000_000n },
      { loan: fakeLoan({ loanId: 2n, note: NOTE_2 }), balance: 0n, claimable: 7_500_000n },
    ]);
    expect(totalClaimableUsd(rows)).toBe(10.5);
  });

  it("is zero for an empty portfolio", () => {
    expect(totalClaimableUsd([])).toBe(0);
  });
});

function claimedEvent(overrides: Partial<ClaimedEvent> & { logIndex: number }): ClaimedEvent {
  return {
    source: "chain",
    type: "Claimed",
    chainId: 84532,
    blockNumber: 100n,
    transactionHash: txHash(overrides.logIndex),
    timestamp: 1_700_000_000,
    loanId: 1n,
    holder: LENDER,
    amount: 5_000_000n,
    ...overrides,
  };
}

describe("claimHistoryFromEvents", () => {
  it("keeps only this holder's own Claimed events, newest first", () => {
    const other: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const events: MergedEvent[] = [
      claimedEvent({ logIndex: 1, timestamp: 100, holder: LENDER, amount: 2_000_000n }),
      claimedEvent({ logIndex: 2, timestamp: 200, holder: other }),
      claimedEvent({ logIndex: 3, timestamp: 300, holder: LENDER, loanId: 2n, amount: 9_000_000n }),
    ];
    const history = claimHistoryFromEvents(events, LENDER);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ loanId: 2n, amountUsd: 9 });
    expect(history[1]).toMatchObject({ loanId: 1n, amountUsd: 2 });
  });

  it("is case-insensitive on the holder address", () => {
    const events: MergedEvent[] = [claimedEvent({ logIndex: 1, holder: LENDER.toUpperCase() as Address })];
    expect(claimHistoryFromEvents(events, LENDER)).toHaveLength(1);
  });

  it("ignores non-Claimed and off-chain events", () => {
    const offChain: MergedEvent = { source: "agent", id: "x", type: "refusal", timestamp: 1, data: {} };
    expect(claimHistoryFromEvents([offChain], LENDER)).toEqual([]);
  });
});

describe("claimHistoryFromJsonEvents", () => {
  it("reads the JSON-safe shape (string amounts/loanIds) into the same entry shape", () => {
    const events: JsonEventLike[] = [
      {
        source: "chain",
        type: "Claimed",
        timestamp: 100,
        transactionHash: "0xabc",
        logIndex: 1,
        loanId: "2",
        holder: LENDER,
        amount: "5000000",
      },
      {
        source: "chain",
        type: "Claimed",
        timestamp: 50,
        transactionHash: "0xdef",
        logIndex: 0,
        loanId: "2",
        holder: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        amount: "1000000",
      },
    ];
    const history = claimHistoryFromJsonEvents(events, LENDER);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ id: "0xabc:1", loanId: 2n, amountUsd: 5, timestamp: 100, txHash: "0xabc" });
  });
});
