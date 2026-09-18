import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { AuctionView, EvidenceBundle, LoanStatus, LoanView, ScoreResult, TermSheet } from "@advance/sdk";
import {
  getAuction,
  getEconomy,
  getLandingData,
  getLoan,
  getLoanEvidence,
  getLoans,
  getScore,
  resetDataLayerForTests,
  type DataClient,
  type DataDeps,
} from "@/lib/data";
import type { EventsPage, EventsQuery, EventsSource, HarvestedEvent } from "@/lib/events";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const AGENT: Address = "0x1111111111111111111111111111111111111111";
const AGENT_CARD: Address = "0x2222222222222222222222222222222222222222";
const FEES_MANAGER: Address = "0x3333333333333333333333333333333333333333";
const TOKEN: Address = "0x4444444444444444444444444444444444444444";

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
    noteSupply: 372_000_000_000_000_000_000n, // -> capUsd 372
    floorCents: 80,
    minPrincipal: 150_000_000n, // $150
    auctionBlocks: 40n,
    drawLimit: 40_000_000n, // $40/day
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
    status: "Active",
    termSheet: fakeTermSheet(),
    escrow: "0x5555555555555555555555555555555555555555",
    note: "0x6666666666666666666666666666666666666666",
    creditLine: "0x7777777777777777777777777777777777777777",
    auction: "0x8888888888888888888888888888888888888888",
    cap: 372_000_000n,
    repaid: 241_800_000n,
    principal: 312_000_000n,
    drawn: 100_000_000n,
    available: 40_000_000n,
    lastRevenueAt: 1_700_000_000n,
    openedAt: 1_699_000_000n,
    activatedAt: 1_699_100_000n,
    ...overrides,
  };
}

function fakeAuction(overrides: Partial<AuctionView> = {}): AuctionView {
  return {
    endBlock: 18_204_400n,
    blocksLeft: 0n,
    graduated: true,
    currency: "0x9999999999999999999999999999999999999999",
    clearingPriceQ96: 84n * ((10_000n * (1n << 96n)) / 10n ** 18n), // 84 cents, exact tick
    requiredCurrencyRaised: 150_000_000n,
    raisedSoFar: 0n,
    ...overrides,
  };
}

function fakeEvidence(overrides: {
  token?: Address;
  haircutBps?: number;
  top5ConcentrationRatio?: number;
  minPrincipal?: bigint;
} = {}): EvidenceBundle {
  return {
    token: overrides.token ?? TOKEN,
    formula: {
      quality: {
        swapCount: 10,
        top5ConcentrationRatio: overrides.top5ConcentrationRatio ?? 0.3,
        washRatio: 0,
        cv: undefined,
        haircutBps: overrides.haircutBps ?? 7100,
      },
      computedTerms: { minPrincipal: overrides.minPrincipal ?? 55_000_000n },
      revenue: {},
    },
  } as unknown as EvidenceBundle;
}

function harvested(overrides: Partial<HarvestedEvent> & { timestamp: number; logIndex: number }): HarvestedEvent {
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

function fakeClient(overrides: Partial<DataClient> = {}): DataClient {
  return {
    loans: vi.fn(async () => []),
    loan: vi.fn(async () => fakeLoan({ status: "None" })),
    auction: vi.fn(async () => fakeAuction()),
    score: vi.fn(async () => ({ kind: "eligible" }) as unknown as ScoreResult),
    evidence: vi.fn(async () => fakeEvidence()),
    ...overrides,
  };
}

function fakeEvents(events: EventsPage["events"] = []): EventsSource {
  return {
    list: vi.fn(async (_query?: EventsQuery): Promise<EventsPage> => ({ events })),
  };
}

const BASE_DEPS: Pick<DataDeps, "webEnv" | "now"> = {
  webEnv: {
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    hub: HUB,
    underwriterApiUrl: "https://underwriter.example.com",
  },
  now: () => 1_700_100_000,
};

function deps(overrides: Partial<DataDeps> = {}): DataDeps {
  return { ...BASE_DEPS, getBlockNumber: async () => 18_204_500n, ...overrides };
}

beforeEach(() => {
  resetDataLayerForTests();
});

describe("getLoans / getLoan / getAuction / getScore / getLoanEvidence", () => {
  it("getLoans passes the filter through and caches by filter", async () => {
    const client = fakeClient({ loans: vi.fn(async () => [fakeLoan()]) });
    const d = deps({ client });

    await getLoans({ status: "Active" }, d);
    await getLoans({ status: "Active" }, d);
    await getLoans({ status: "Repaid" }, d);

    expect(client.loans).toHaveBeenCalledTimes(2); // one per distinct filter, second "Active" call is cached
  });

  it("getLoan returns null for a loan that never opened (status None)", async () => {
    const client = fakeClient({ loan: vi.fn(async () => fakeLoan({ status: "None" })) });
    expect(await getLoan(999n, deps({ client }))).toBeNull();
  });

  it("getLoan returns the real loan view otherwise", async () => {
    const loan = fakeLoan();
    const client = fakeClient({ loan: vi.fn(async () => loan) });
    expect(await getLoan(1n, deps({ client }))).toEqual(loan);
  });

  it("getAuction returns null without calling client.auction when the loan doesn't exist", async () => {
    const client = fakeClient({ loan: vi.fn(async () => fakeLoan({ status: "None" })) });
    const auction = await getAuction(999n, deps({ client }));
    expect(auction).toBeNull();
    expect(client.auction).not.toHaveBeenCalled();
  });

  it("getAuction returns the real auction view when the loan exists", async () => {
    const client = fakeClient({ loan: vi.fn(async () => fakeLoan()), auction: vi.fn(async () => fakeAuction()) });
    const auction = await getAuction(1n, deps({ client }));
    expect(auction).toEqual(fakeAuction());
  });

  it("getScore delegates to the client, lowercasing the cache key", async () => {
    const client = fakeClient();
    const d = deps({ client });
    await getScore(TOKEN, d);
    await getScore(TOKEN.toUpperCase() as Address, d);
    expect(client.score).toHaveBeenCalledTimes(1);
  });

  it("getLoanEvidence fetches by the term sheet's memoHash", async () => {
    const loan = fakeLoan();
    const client = fakeClient({ evidence: vi.fn(async (hash: Hex) => fakeEvidence({ token: TOKEN })) });
    const evidence = await getLoanEvidence(loan, deps({ client }));
    expect(client.evidence).toHaveBeenCalledWith(loan.termSheet.memoHash);
    expect(evidence?.token).toBe(TOKEN);
  });

  it("getLoanEvidence returns undefined (not a throw) when the underwriter no longer has it", async () => {
    const client = fakeClient({
      evidence: vi.fn(async () => {
        throw new Error("404");
      }),
    });
    const evidence = await getLoanEvidence(fakeLoan(), deps({ client }));
    expect(evidence).toBeUndefined();
  });
});

describe("getEconomy", () => {
  it("returns an empty agent list when there are no loans", async () => {
    const client = fakeClient({ loans: vi.fn(async () => []) });
    const economy = await getEconomy(deps({ client, events: fakeEvents([]) }));
    expect(economy.agents).toEqual([]);
  });

  it("collapses multiple loans for the same agent to the most recently opened one", async () => {
    const older = fakeLoan({ loanId: 1n, openedAt: 100n, status: "Repaid" });
    const newer = fakeLoan({ loanId: 2n, openedAt: 200n, status: "Active" });
    const client = fakeClient({ loans: vi.fn(async () => [older, newer]) });
    const economy = await getEconomy(deps({ client, events: fakeEvents([]) }));
    expect(economy.agents).toHaveLength(1);
    expect(economy.agents[0]?.loanId).toBe(2n);
  });

  it("sums real Harvested.usdcOut within the lookback window as revenue7dUsdc", async () => {
    const loan = fakeLoan();
    const client = fakeClient({ loans: vi.fn(async () => [loan]) });
    const now = BASE_DEPS.now!();
    const withinWindow = harvested({ timestamp: now - 3600, logIndex: 1, usdcOut: 10_000_000n });
    const outsideWindow = harvested({ timestamp: now - 8 * 24 * 60 * 60, logIndex: 2, usdcOut: 999_000_000n });
    const events = fakeEvents([withinWindow, outsideWindow]);

    const economy = await getEconomy(deps({ client, events }));
    expect(economy.agents[0]?.revenue7dUsdc).toBe(10_000_000n);
  });

  it("computes runwaySeconds from the grace period, only for Active loans", async () => {
    const active = fakeLoan({ status: "Active", lastRevenueAt: 1_700_000_000n, termSheet: fakeTermSheet({ gracePeriod: 100_000n }) });
    const repaid = fakeLoan({ loanId: 2n, status: "Repaid", termSheet: fakeTermSheet({ agentTreasury: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address }) });
    const client = fakeClient({ loans: vi.fn(async () => [active, repaid]) });

    const economy = await getEconomy(deps({ client, events: fakeEvents([]) }));
    const activeRow = economy.agents.find((a) => a.loanId === 1n);
    const repaidRow = economy.agents.find((a) => a.loanId === 2n);

    // now (1_700_100_000) - lastRevenueAt (1_700_000_000) = 100_000; gracePeriod 100_000 -> 0 left.
    expect(activeRow?.runwaySeconds).toBe(0n);
    expect(repaidRow?.runwaySeconds).toBeNull();
  });

  it("caches across calls within the TTL", async () => {
    const client = fakeClient({ loans: vi.fn(async () => [fakeLoan()]) });
    const d = deps({ client, events: fakeEvents([]) });
    await getEconomy(d);
    await getEconomy(d);
    expect(client.loans).toHaveBeenCalledTimes(1);
  });
});

describe("getLandingData", () => {
  it("returns an honest empty state when there are no loans", async () => {
    const client = fakeClient({ loans: vi.fn(async () => []) });
    const data = await getLandingData(deps({ client, events: fakeEvents([]) }));

    expect(data.hero.agent).toBe("0x0000000000000000000000000000000000000000");
    expect(data.hero.loansRepaid).toBe(0);
    expect(data.hero.note.sweeps).toEqual([]);
    expect(data.economy.fundedAgents).toBe(0);
  });

  it("builds a real certificate from the most recent Active loan", async () => {
    const loan = fakeLoan();
    const client = fakeClient({
      loans: vi.fn(async () => [loan]),
      loan: vi.fn(async () => loan),
      auction: vi.fn(async () => fakeAuction()),
      evidence: vi.fn(async () => fakeEvidence({ token: TOKEN, haircutBps: 7100, top5ConcentrationRatio: 0.3, minPrincipal: 55_000_000n })),
    });
    const now = BASE_DEPS.now!();
    const sweep1 = harvested({ timestamp: now - 1000, logIndex: 1, usdcOut: 8_000_000n });
    const sweep2 = harvested({ timestamp: now - 500, logIndex: 2, usdcOut: 9_000_000n });
    const events = fakeEvents([sweep2, sweep1]); // newest first, as EventsSource.list returns

    const data = await getLandingData(deps({ client, events }));

    expect(data.hero.agent).toBe(AGENT);
    expect(data.hero.note.capUsd).toBe(372);
    expect(data.hero.note.notesOutstanding).toBe(372);
    expect(data.hero.note.borrowedUsd).toBe(312);
    expect(data.hero.note.repaidUsd).toBe(241.8);
    expect(data.hero.note.clearingPriceCents).toBe(84);
    expect(data.hero.note.capMultiple).toBeCloseTo(372 / 312);
    // Reversed to chronological (oldest first).
    expect(data.hero.note.sweeps).toEqual([8, 9]);

    expect(data.lifecycle.score).toBe(71); // 7100 bps -> 71
    expect(data.lifecycle.floorCents).toBe(80);
    expect(data.lifecycle.dailyLimitUsd).toBe(40);

    expect(data.audiences.token).toBe(TOKEN);
    expect(data.audiences.memo.largestPoolSharePct).toBe(30);
    expect(data.audiences.memo.formulaLimitUsd).toBe(55);
    expect(data.audiences.auction.steps).toEqual([
      { fromBlock: 0, priceCents: 80 },
      { fromBlock: 40, priceCents: 84 },
    ]);
  });

  it("falls back to floorCents for the clearing price when the auction can't be read", async () => {
    const loan = fakeLoan();
    const client = fakeClient({
      loans: vi.fn(async () => [loan]),
      loan: vi.fn(async () => fakeLoan({ status: "None" })), // getAuction -> null
    });
    const data = await getLandingData(deps({ client, events: fakeEvents([]) }));
    expect(data.hero.note.clearingPriceCents).toBe(80);
    expect(data.audiences.auction.steps).toEqual([]);
  });

  it("prefers an Active loan over a more recently opened non-active one", async () => {
    const active = fakeLoan({ loanId: 1n, status: "Active", openedAt: 100n });
    const failed = fakeLoan({
      loanId: 2n,
      status: "Failed",
      openedAt: 200n,
      termSheet: fakeTermSheet({ agentTreasury: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address }),
    });
    const client = fakeClient({
      loans: vi.fn(async () => [active, failed]),
      loan: vi.fn(async (id: bigint) => (id === 1n ? active : failed)),
    });
    const data = await getLandingData(deps({ client, events: fakeEvents([]) }));
    expect(data.hero.agent).toBe(AGENT);
  });

  it("caches across calls within the TTL", async () => {
    const client = fakeClient({ loans: vi.fn(async () => []) });
    const d = deps({ client, events: fakeEvents([]) });
    await getLandingData(d);
    await getLandingData(d);
    expect(client.loans).toHaveBeenCalledTimes(1);
  });
});
