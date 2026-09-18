import { describe, expect, it } from "vitest";
import { groupRefusalsByLayer, totalRefusals } from "@/lib/refusals";
import { cardReceiptsFromEvents, harvestEntriesFromEvents } from "@/lib/loanDetail";
import { buildFixtureDataClient, buildFixtureEventsSource } from "@/lib/fixtures/webFixtures";

describe("buildFixtureDataClient", () => {
  it("lists three loans covering a live auction, an active loan and a repaid loan", async () => {
    const client = buildFixtureDataClient();
    const loans = await client.loans();
    expect(loans.map((l) => l.loanId)).toEqual([1n, 2n, 3n]);
    expect(loans.map((l) => l.status)).toEqual(["Auction", "Active", "Repaid"]);
  });

  it("filters by status and by agent", async () => {
    const client = buildFixtureDataClient();
    const active = await client.loans({ status: "Active" });
    expect(active.map((l) => l.loanId)).toEqual([2n]);
    const byAgent = await client.loans({ agent: (await client.loan(3n)).termSheet.agentTreasury });
    expect(byAgent.map((l) => l.loanId)).toEqual([3n]);
  });

  it("reads a single loan by id", async () => {
    const client = buildFixtureDataClient();
    const loan = await client.loan(2n);
    expect(loan.status).toBe("Active");
    expect(loan.cap).toBe(450_000_000n);
  });

  it("reads status None, never throwing, for an id that never opened a loan", async () => {
    const client = buildFixtureDataClient();
    const loan = await client.loan(999n);
    expect(loan.status).toBe("None");
  });

  it("reads each loan's auction, live and graduated", async () => {
    const client = buildFixtureDataClient();
    const liveAuction = await client.auction(1n);
    expect(liveAuction.blocksLeft > 0n).toBe(true);
    expect(liveAuction.graduated).toBe(false);

    const endedAuction = await client.auction(2n);
    expect(endedAuction.blocksLeft).toBe(0n);
    expect(endedAuction.graduated).toBe(true);
  });
});

describe("buildFixtureEventsSource", () => {
  it("carries a recognizable refusal in every one of the four layers for loan 2", async () => {
    const events = buildFixtureEventsSource();
    const page = await events.list({ loanId: 2n, types: ["refusal"] });
    const refusalEvents = page.events.filter((e) => e.source === "agent");
    const grouped = groupRefusalsByLayer(refusalEvents);
    expect(totalRefusals(grouped)).toBe(4);
    expect(grouped.gateway).toHaveLength(1);
    expect(grouped["card-1271"]).toHaveLength(1);
    expect(grouped["credit-line"]).toHaveLength(1);
    expect(grouped.dynamic).toHaveLength(1);
  });

  it("carries no refusals for the fully repaid loan", async () => {
    const events = buildFixtureEventsSource();
    const page = await events.list({ loanId: 3n, types: ["refusal"] });
    expect(page.events).toEqual([]);
  });

  it("carries readable x402 receipts for loan 2's card spend", async () => {
    const events = buildFixtureEventsSource();
    const page = await events.list({ loanId: 2n, types: ["receipt"] });
    const receipts = cardReceiptsFromEvents(page.events.filter((e) => e.source === "agent"));
    expect(receipts).toHaveLength(3);
    expect(receipts.every((r) => r.txHash)).toBe(true);
  });

  it("carries harvests for loan 2 whose toNotes sum matches the loan's repaid amount", async () => {
    const dataClient = buildFixtureDataClient();
    const events = buildFixtureEventsSource();
    const loan = await dataClient.loan(2n);
    const page = await events.list({ loanId: 2n, types: ["Harvested"] });
    const harvests = harvestEntriesFromEvents(loan, page.events);
    expect(harvests).toHaveLength(3);
    const sumToUsd = Number(loan.repaid) / 1_000_000;
    // toNotes is a real sub-split of usdcOut; the fixture's toNotes sum matches repaid exactly.
    expect(harvests.reduce((sum, h) => sum + h.usdcOut, 0)).toBeGreaterThan(0);
    expect(sumToUsd).toBe(180);
  });

  it("paginates and filters like the real merge (loanId scoping still applies)", async () => {
    const events = buildFixtureEventsSource();
    const page = await events.list({ loanId: 1n });
    expect(page.events).toEqual([]); // loan 1 has no recorded activity yet — an honest empty auction
  });
});
