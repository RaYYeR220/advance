import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { AgentEvent } from "@advance/agent-kit";
import {
  DEFAULT_HARVEST_MIN_WETH,
  decideForLoan,
  tick,
  type KeeperActions,
  type KeeperChainReader,
  type LoanSnapshot,
} from "../src/keeper.js";

const CREDIT_LINE = "0x1000000000000000000000000000000000000A" as Address;
const AUCTION = "0x1000000000000000000000000000000000000B" as Address;
const ESCROW = "0x1000000000000000000000000000000000000C" as Address;

function baseSnapshot(overrides: Partial<LoanSnapshot> = {}): LoanSnapshot {
  return {
    loanId: 1n,
    status: 1, // Auction
    creditLine: CREDIT_LINE,
    creditLineState: 0, // Pending
    auction: AUCTION,
    auctionEndBlock: 1000n,
    escrow: ESCROW,
    escrowPhase: 0, // Pending
    lastRevenueAt: 0n,
    gracePeriod: 86_400n,
    pendingHarvestWeth: 0n,
    noteRemainingCap: 1_000_000n,
    escrowUsdcBalance: 0n,
    ...overrides,
  };
}

const NOW = { blockNumber: 1000n, timestamp: 500_000n };

describe("decideForLoan", () => {
  it("settles an ended auction whose credit line is still Pending", () => {
    const decision = decideForLoan(baseSnapshot({ auctionEndBlock: 999n }), NOW, { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH });
    expect(decision).toEqual({ action: "settleAuction", creditLine: CREDIT_LINE });
  });

  it("does not settle before the auction has ended", () => {
    const decision = decideForLoan(baseSnapshot({ auctionEndBlock: 1001n }), NOW, { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH });
    expect(decision).toEqual({ action: "none" });
  });

  it("never re-settles once the credit line has left Pending (idempotent)", () => {
    const decision = decideForLoan(
      baseSnapshot({ auctionEndBlock: 1n, creditLineState: 1 /* Active */ }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "none" });
  });

  it("harvests an Active loan once pending WETH clears the threshold", () => {
    const decision = decideForLoan(
      baseSnapshot({ status: 2 /* Active */, escrowPhase: 1 /* Active */, pendingHarvestWeth: DEFAULT_HARVEST_MIN_WETH }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "harvest", escrow: ESCROW });
  });

  it("harvests below the WETH threshold when the note's cap is already reachable", () => {
    const decision = decideForLoan(
      baseSnapshot({
        status: 2,
        escrowPhase: 1,
        pendingHarvestWeth: 0n,
        noteRemainingCap: 500n,
        escrowUsdcBalance: 500n,
      }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "harvest", escrow: ESCROW });
  });

  it("does nothing for an Active loan below threshold, cap unreachable, and still in grace", () => {
    const decision = decideForLoan(
      baseSnapshot({ status: 2, escrowPhase: 1, lastRevenueAt: 490_000n, gracePeriod: 86_400n }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "none" });
  });

  it("marks an Active loan defaulted once now exceeds lastRevenueAt + gracePeriod", () => {
    const decision = decideForLoan(
      baseSnapshot({ status: 2, escrowPhase: 0 /* not Active, no harvest possible */, lastRevenueAt: 100n, gracePeriod: 100n }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "markDefault", loanId: 1n });
  });

  it("prefers harvest over markDefault when both conditions hold", () => {
    const decision = decideForLoan(
      baseSnapshot({
        status: 2,
        escrowPhase: 1,
        pendingHarvestWeth: DEFAULT_HARVEST_MIN_WETH,
        lastRevenueAt: 0n,
        gracePeriod: 1n,
      }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "harvest", escrow: ESCROW });
  });

  it("still allows a late harvest on an already-Defaulted loan (cap reach after default)", () => {
    const decision = decideForLoan(
      baseSnapshot({ status: 4 /* Defaulted */, escrowPhase: 1, pendingHarvestWeth: DEFAULT_HARVEST_MIN_WETH }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "harvest", escrow: ESCROW });
  });

  it("never re-defaults an already-Defaulted loan", () => {
    const decision = decideForLoan(
      baseSnapshot({ status: 4, escrowPhase: 0, lastRevenueAt: 0n, gracePeriod: 1n }),
      NOW,
      { harvestMinWeth: DEFAULT_HARVEST_MIN_WETH },
    );
    expect(decision).toEqual({ action: "none" });
  });

  it.each([3, 5, 6, 0])("does nothing for terminal/unopened status %i", (status) => {
    const decision = decideForLoan(baseSnapshot({ status, lastRevenueAt: 0n, gracePeriod: 0n }), NOW, {
      harvestMinWeth: DEFAULT_HARVEST_MIN_WETH,
    });
    expect(decision).toEqual({ action: "none" });
  });
});

function fakeEvents() {
  const events: Array<Omit<AgentEvent, "ts"> & { ts?: number }> = [];
  return { events, append: async (e: Omit<AgentEvent, "ts"> & { ts?: number }) => void events.push(e) };
}

function readerFor(snapshots: Record<string, LoanSnapshot>): KeeperChainReader {
  return {
    async loanCount() {
      return BigInt(Object.keys(snapshots).length);
    },
    async loanSnapshot(loanId: bigint) {
      const snap = snapshots[loanId.toString()];
      if (!snap) throw new Error(`no fixture for loan ${loanId}`);
      return snap;
    },
    async now() {
      return NOW;
    },
  };
}

describe("tick", () => {
  it("checks every loan and takes exactly the decided action per loan", async () => {
    const snapshots: Record<string, LoanSnapshot> = {
      "1": baseSnapshot({ loanId: 1n, auctionEndBlock: 1n }), // -> settleAuction
      "2": baseSnapshot({
        loanId: 2n,
        status: 2,
        escrowPhase: 1,
        pendingHarvestWeth: DEFAULT_HARVEST_MIN_WETH,
      }), // -> harvest
      "3": baseSnapshot({ loanId: 3n, status: 3 }), // Repaid -> none
    };
    const calls: string[] = [];
    const actions: KeeperActions = {
      settleAuction: async (creditLine) => {
        calls.push(`settleAuction:${creditLine}`);
        return "0xaaa" as Hex;
      },
      harvest: async (escrow) => {
        calls.push(`harvest:${escrow}`);
        return "0xbbb" as Hex;
      },
      markDefault: async (loanId) => {
        calls.push(`markDefault:${loanId}`);
        return "0xccc" as Hex;
      },
    };
    const { append } = fakeEvents();

    const result = await tick({ reader: readerFor(snapshots), actions, events: { append }, agent: "keeper" });

    expect(result.checked).toBe(3);
    expect(calls).toEqual([`settleAuction:${CREDIT_LINE}`, `harvest:${ESCROW}`]);
    expect(result.actionsTaken).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("is idempotent across ticks: a settled auction is never settled again", async () => {
    let creditLineState = 0; // Pending
    const reader: KeeperChainReader = {
      async loanCount() {
        return 1n;
      },
      async loanSnapshot() {
        return baseSnapshot({ auctionEndBlock: 1n, creditLineState });
      },
      async now() {
        return NOW;
      },
    };
    let settleCalls = 0;
    const actions: KeeperActions = {
      settleAuction: async () => {
        settleCalls++;
        creditLineState = 1; // Active, as the real contract would transition it
        return "0xaaa" as Hex;
      },
      harvest: async () => "0xbbb" as Hex,
      markDefault: async () => "0xccc" as Hex,
    };
    const { append } = fakeEvents();

    await tick({ reader, actions, events: { append }, agent: "keeper" });
    await tick({ reader, actions, events: { append }, agent: "keeper" });

    expect(settleCalls).toBe(1);
  });

  it("logs a per-loan error and keeps checking the rest of the book, never throwing", async () => {
    const OTHER_CREDIT_LINE = "0x2000000000000000000000000000000000000A" as Address;
    const snapshots: Record<string, LoanSnapshot> = {
      "1": baseSnapshot({ loanId: 1n, auctionEndBlock: 1n }),
      "2": baseSnapshot({ loanId: 2n, auctionEndBlock: 1n, creditLine: OTHER_CREDIT_LINE }),
    };
    const actions: KeeperActions = {
      settleAuction: async (creditLine) => {
        if (creditLine === CREDIT_LINE) throw new Error("rpc blip");
        return "0xaaa" as Hex;
      },
      harvest: async () => "0xbbb" as Hex,
      markDefault: async () => "0xccc" as Hex,
    };
    const { events, append } = fakeEvents();

    const result = await tick({ reader: readerFor(snapshots), actions, events: { append }, agent: "keeper" });

    expect(result.checked).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.loanId).toBe(1n);
    expect(events.some((e) => e.kind === "keeper_error")).toBe(true);
  });

  it("never throws even when the reader itself fails to enumerate loans", async () => {
    const reader: KeeperChainReader = {
      async loanCount() {
        throw new Error("rpc down");
      },
      async loanSnapshot() {
        throw new Error("unreachable");
      },
      async now() {
        return NOW;
      },
    };
    const { events, append } = fakeEvents();

    const result = await tick({
      reader,
      actions: {
        settleAuction: async () => "0xaaa" as Hex,
        harvest: async () => "0xbbb" as Hex,
        markDefault: async () => "0xccc" as Hex,
      },
      events: { append },
      agent: "keeper",
    });

    expect(result.checked).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(events.some((e) => e.kind === "keeper_error")).toBe(true);
  });
});
