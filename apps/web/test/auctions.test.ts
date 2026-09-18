import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { AuctionView, LoanView, TermSheet } from "@advance/sdk";
import { auctionChartData, clearingPriceCents, isLiveAuction, sortAuctionListItems, type AuctionListItem } from "@/lib/auctions";

const AGENT: Address = "0x1111111111111111111111111111111111111111";
const AGENT_CARD: Address = "0x2222222222222222222222222222222222222222";
const FEES_MANAGER: Address = "0x3333333333333333333333333333333333333333";

const TICK_Q96 = (10_000n * (1n << 96n)) / 10n ** 18n;

function centsQ96(cents: number): bigint {
  return BigInt(cents) * TICK_Q96;
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
    drawLimit: 40_000_000n,
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
    loanId: 1n,
    status: "Auction",
    termSheet: fakeTermSheet(),
    escrow: "0x5555555555555555555555555555555555555555",
    note: "0x6666666666666666666666666666666666666666",
    creditLine: "0x7777777777777777777777777777777777777777",
    auction: "0x8888888888888888888888888888888888888888",
    cap: 372_000_000n,
    repaid: 0n,
    principal: 0n,
    drawn: 0n,
    available: 0n,
    lastRevenueAt: 0n,
    openedAt: 1_699_000_000n,
    activatedAt: 0n,
    ...overrides,
  };
}

function fakeAuction(overrides: Partial<AuctionView> = {}): AuctionView {
  return {
    endBlock: 18_204_400n,
    blocksLeft: 20n,
    graduated: false,
    currency: "0x9999999999999999999999999999999999999999",
    clearingPriceQ96: centsQ96(84),
    requiredCurrencyRaised: 150_000_000n,
    raisedSoFar: 60_000_000n,
    ...overrides,
  };
}

describe("clearingPriceCents", () => {
  it("rounds a live checkpoint down to the nearest tick before converting", () => {
    const auction = fakeAuction({ clearingPriceQ96: centsQ96(84) + TICK_Q96 / 2n });
    expect(clearingPriceCents(auction)).toBe(84);
  });

  it("reads an exact tick unchanged", () => {
    expect(clearingPriceCents(fakeAuction({ clearingPriceQ96: centsQ96(91) }))).toBe(91);
  });
});

describe("isLiveAuction", () => {
  it("is live while blocks remain, regardless of graduation", () => {
    expect(isLiveAuction({ loan: fakeLoan(), auction: fakeAuction({ blocksLeft: 5n, graduated: true }) })).toBe(true);
    expect(isLiveAuction({ loan: fakeLoan(), auction: fakeAuction({ blocksLeft: 5n, graduated: false }) })).toBe(true);
  });

  it("is not live once no blocks remain", () => {
    expect(isLiveAuction({ loan: fakeLoan(), auction: fakeAuction({ blocksLeft: 0n }) })).toBe(false);
  });
});

describe("sortAuctionListItems", () => {
  it("lists live auctions first, soonest-ending first, then ended ones newest-opened first", () => {
    const items: AuctionListItem[] = [
      { loan: fakeLoan({ loanId: 1n, openedAt: 100n }), auction: fakeAuction({ blocksLeft: 0n }) }, // ended, oldest
      { loan: fakeLoan({ loanId: 2n, openedAt: 300n }), auction: fakeAuction({ blocksLeft: 10n }) }, // live
      { loan: fakeLoan({ loanId: 3n, openedAt: 200n }), auction: fakeAuction({ blocksLeft: 0n }) }, // ended, newer
      { loan: fakeLoan({ loanId: 4n, openedAt: 400n }), auction: fakeAuction({ blocksLeft: 2n }) }, // live, ending soonest
    ];
    const sorted = sortAuctionListItems(items);
    expect(sorted.map((i) => i.loan.loanId)).toEqual([4n, 2n, 3n, 1n]);
  });

  it("is stable and total on an all-live or all-ended list", () => {
    const allLive: AuctionListItem[] = [
      { loan: fakeLoan({ loanId: 1n }), auction: fakeAuction({ blocksLeft: 5n }) },
      { loan: fakeLoan({ loanId: 2n }), auction: fakeAuction({ blocksLeft: 1n }) },
    ];
    expect(sortAuctionListItems(allLive).map((i) => i.loan.loanId)).toEqual([2n, 1n]);
  });
});

describe("auctionChartData", () => {
  it("builds a two-point step schedule once blocks have elapsed", () => {
    const loan = fakeLoan({ termSheet: fakeTermSheet({ auctionBlocks: 40n, floorCents: 80 }) });
    const auction = fakeAuction({ endBlock: 1_000n, blocksLeft: 28n, clearingPriceQ96: centsQ96(84) });
    const data = auctionChartData(loan, auction);
    expect(data.startBlock).toBe(960);
    expect(data.blocks).toBe(40);
    expect(data.floorCents).toBe(80);
    expect(data.elapsedBlocks).toBe(12);
    expect(data.clearingPriceCents).toBe(84);
    expect(data.steps).toEqual([
      { fromBlock: 0, priceCents: 80 },
      { fromBlock: 12, priceCents: 84 },
    ]);
  });

  it("holds at the floor alone before any block has elapsed", () => {
    const loan = fakeLoan({ termSheet: fakeTermSheet({ auctionBlocks: 40n, floorCents: 80 }) });
    const auction = fakeAuction({ endBlock: 1_040n, blocksLeft: 40n, clearingPriceQ96: centsQ96(80) });
    const data = auctionChartData(loan, auction);
    expect(data.elapsedBlocks).toBe(0);
    expect(data.steps).toEqual([{ fromBlock: 0, priceCents: 80 }]);
  });

  it("clamps elapsed blocks to the auction's own length", () => {
    const loan = fakeLoan({ termSheet: fakeTermSheet({ auctionBlocks: 40n, floorCents: 80 }) });
    const auction = fakeAuction({ endBlock: 1_000n, blocksLeft: 0n, clearingPriceQ96: centsQ96(90) });
    const data = auctionChartData(loan, auction);
    expect(data.elapsedBlocks).toBe(40);
  });
});
