import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { LoanView, TermSheet } from "@advance/sdk";
import type { AgentEvent, HarvestedEvent, LoanActivatedEvent, LoanOpenedEvent, LoanRepaidEvent, MergedEvent } from "@/lib/events";
import {
  cardReceiptsFromEvents,
  drawMeterFromLoan,
  drawPeriodLabel,
  harvestEntriesFromEvents,
  noteTermsFromLoan,
  statusHistoryFromEvents,
  toCardReceipt,
} from "@/lib/loanDetail";

const AGENT: Address = "0x1111111111111111111111111111111111111111";
const AGENT_CARD: Address = "0x2222222222222222222222222222222222222222";
const FEES_MANAGER: Address = "0x3333333333333333333333333333333333333333";
const PAYEE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function fakeTermSheet(overrides: Partial<TermSheet> = {}): TermSheet {
  return {
    agentTreasury: AGENT,
    agentCard: AGENT_CARD,
    agentId: 0n,
    feesManager: FEES_MANAGER,
    poolId: `0x${"1".repeat(64)}` as Hex,
    expectedShares: 950_000_000_000_000_000n,
    noteSupply: 372_000_000_000_000_000_000n,
    floorCents: 80,
    minPrincipal: 150_000_000n,
    auctionBlocks: 40n,
    drawLimit: 40_000_000n, // $40/period
    drawPeriod: 86_400n,
    gracePeriod: 14n * 86_400n,
    deadline: 4_000_000_000n,
    nonce: 1n,
    memoHash: `0x${"a".repeat(64)}` as Hex,
    ...overrides,
  };
}

function fakeLoan(overrides: Partial<LoanView> = {}): LoanView {
  return {
    loanId: 7n,
    status: "Active",
    termSheet: fakeTermSheet(),
    escrow: "0x5555555555555555555555555555555555555555",
    note: "0x6666666666666666666666666666666666666666",
    creditLine: "0x7777777777777777777777777777777777777777",
    auction: "0x8888888888888888888888888888888888888888",
    cap: 372_000_000n,
    repaid: 241_800_000n,
    principal: 312_000_000n,
    drawn: 15_000_000n,
    available: 25_000_000n, // $25 left this period of a $40 limit
    lastRevenueAt: 1_700_000_000n,
    openedAt: 1_699_000_000n,
    activatedAt: 1_699_100_000n,
    ...overrides,
  };
}

describe("noteTermsFromLoan", () => {
  it("converts USDC-wei amounts to USD and computes the cap multiple", () => {
    const terms = noteTermsFromLoan(fakeLoan(), { clearingPriceCents: 84, sweepsUsd: [10, 15], latestBlock: 500 });
    expect(terms).toEqual({
      agentLabel: "0x1111",
      series: "0x1111",
      notesOutstanding: 372,
      repaidPerNote: 1,
      clearingPriceCents: 84,
      capMultiple: 372 / 312,
      borrowedUsd: 312,
      repaidUsd: 241.8,
      capUsd: 372,
      sweeps: [10, 15],
      latestBlock: 500,
    });
  });

  it("reads a zero cap multiple before anything has been borrowed", () => {
    const terms = noteTermsFromLoan(fakeLoan({ principal: 0n }), { clearingPriceCents: 80, sweepsUsd: [], latestBlock: 0 });
    expect(terms.capMultiple).toBe(0);
  });
});

describe("drawPeriodLabel", () => {
  it("reads a full day as 'day'", () => {
    expect(drawPeriodLabel(86_400n)).toBe("day");
  });

  it("reads a whole number of hours", () => {
    expect(drawPeriodLabel(6n * 3_600n)).toBe("6-hour period");
  });

  it("reads a whole number of minutes when it isn't an even hour", () => {
    expect(drawPeriodLabel(90n * 60n)).toBe("90-minute period");
  });
});

describe("drawMeterFromLoan", () => {
  it("derives used from the limit and what's still available this period", () => {
    const meter = drawMeterFromLoan(fakeLoan());
    expect(meter).toEqual({ limitUsd: 40, usedUsd: 15, availableUsd: 25, periodLabel: "day" });
  });

  it("never reads negative used when available exceeds the limit", () => {
    const meter = drawMeterFromLoan(fakeLoan({ available: 999_000_000n }));
    expect(meter.usedUsd).toBe(0);
  });
});

function harvested(overrides: Partial<HarvestedEvent> & { logIndex: number; timestamp: number; loanId?: bigint }): HarvestedEvent {
  return {
    source: "chain",
    type: "Harvested",
    chainId: 84532,
    blockNumber: 100n,
    transactionHash: txHash(overrides.logIndex),
    wethIn: 1n,
    usdcOut: 10_000_000n,
    toNotes: 8_000_000n,
    toTreasury: 2_000_000n,
    ...overrides,
  };
}

describe("harvestEntriesFromEvents", () => {
  it("reads this loan's harvests, oldest first, converted to USD", () => {
    const loan = fakeLoan({ loanId: 7n });
    const events: MergedEvent[] = [
      harvested({ logIndex: 1, timestamp: 300, loanId: 7n, usdcOut: 20_000_000n }),
      harvested({ logIndex: 2, timestamp: 100, loanId: 7n, usdcOut: 5_000_000n }),
      harvested({ logIndex: 3, timestamp: 200, loanId: 9n, usdcOut: 999_000_000n }), // different loan
    ];
    const harvests = harvestEntriesFromEvents(loan, events);
    expect(harvests.map((h) => h.usdcOut)).toEqual([5, 20]);
    expect(harvests[0]?.timestamp).toBe(100);
    expect(harvests.every((h) => h.txHash.startsWith("0x"))).toBe(true);
  });

  it("returns empty for a loan with no harvests", () => {
    expect(harvestEntriesFromEvents(fakeLoan(), [])).toEqual([]);
  });
});

describe("toCardReceipt / cardReceiptsFromEvents", () => {
  function receiptEvent(overrides: Partial<AgentEvent> & { data?: Record<string, unknown> } = {}): AgentEvent {
    return {
      source: "agent",
      id: overrides.id ?? "r1",
      type: "receipt",
      timestamp: overrides.timestamp ?? 1_700_000_000,
      data: { payee: PAYEE, amount: "3.20", ...overrides.data },
      ...overrides,
    };
  }

  it("reads a well-formed receipt", () => {
    const receipt = toCardReceipt(receiptEvent({ txHash: txHash(1) }));
    expect(receipt).toEqual({ id: "r1", timestamp: 1_700_000_000, payee: PAYEE, amountUsdc: "3.20", txHash: txHash(1) });
  });

  it("ignores a non-receipt event", () => {
    expect(toCardReceipt(receiptEvent({ type: "refusal" }))).toBeUndefined();
  });

  it("drops a receipt with no readable payee", () => {
    expect(toCardReceipt(receiptEvent({ data: { payee: "not-an-address" } }))).toBeUndefined();
  });

  it("sorts every readable receipt newest first", () => {
    const events: AgentEvent[] = [
      receiptEvent({ id: "a", timestamp: 100 }),
      receiptEvent({ id: "b", timestamp: 300 }),
      receiptEvent({ id: "c", timestamp: 200 }),
    ];
    expect(cardReceiptsFromEvents(events).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("statusHistoryFromEvents", () => {
  it("always includes opened, refined with a tx hash when a matching chain event is in range", () => {
    const loan = fakeLoan({ loanId: 7n, activatedAt: 0n });
    const opened: LoanOpenedEvent = {
      source: "chain",
      type: "LoanOpened",
      chainId: 84532,
      blockNumber: 1n,
      transactionHash: txHash(1),
      logIndex: 0,
      timestamp: 1_699_000_000,
      loanId: 7n,
      agentTreasury: AGENT,
      escrow: "0x5555555555555555555555555555555555555555",
      note: "0x6666666666666666666666666666666666666666",
      creditLine: "0x7777777777777777777777777777777777777777",
      auction: "0x8888888888888888888888888888888888888888",
    };
    const history = statusHistoryFromEvents(loan, [opened]);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ id: "LoanOpened", label: "Auction opened", timestamp: 1_699_000_000, txHash: txHash(1) });
  });

  it("falls back to the loan's own opened/activated timestamps outside the feed's lookback", () => {
    const loan = fakeLoan({ loanId: 7n, openedAt: 1_699_000_000n, activatedAt: 1_699_100_000n });
    const history = statusHistoryFromEvents(loan, []);
    expect(history.map((h) => h.id)).toEqual(["LoanOpened", "LoanActivated"]);
    expect(history.every((h) => h.txHash === undefined)).toBe(true);
  });

  it("orders every milestone chronologically and includes settlement failures", () => {
    const loan = fakeLoan({ loanId: 7n, openedAt: 100n, activatedAt: 200n });
    const activated: LoanActivatedEvent = {
      source: "chain",
      type: "LoanActivated",
      chainId: 84532,
      blockNumber: 2n,
      transactionHash: txHash(2),
      logIndex: 0,
      timestamp: 200,
      loanId: 7n,
      principal: 312_000_000n,
    };
    const repaid: LoanRepaidEvent = {
      source: "chain",
      type: "LoanRepaid",
      chainId: 84532,
      blockNumber: 3n,
      transactionHash: txHash(3),
      logIndex: 0,
      timestamp: 500,
      loanId: 7n,
      totalRepaid: 372_000_000n,
    };
    const failure: AgentEvent = {
      source: "agent",
      id: "sf1",
      type: "settlement_failed",
      loanId: "7",
      timestamp: 350,
      data: { reason: "sweep reverted" },
      txHash: txHash(4),
    };
    const history = statusHistoryFromEvents(loan, [repaid, failure, activated]);
    expect(history.map((h) => h.id)).toEqual(["LoanOpened", "LoanActivated", "sf1", "LoanRepaid"]);
  });
});
