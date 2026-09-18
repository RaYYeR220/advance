import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  createEventsSource,
  decodeCursor,
  estimateBlockAtTimestamp,
  filterEvents,
  mergeAndPaginate,
  parseAgentEvent,
  parseAgentEvents,
  readOffChainEvents,
  readOnChainEvents,
  type AgentEvent,
  type ChainEventsContext,
  type ChainLogEntry,
  type ChainLogsClient,
  type HarvestedEvent,
  type LoanContractAddresses,
  type LoanOpenedEvent,
  type OnChainEvent,
} from "@/lib/events";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const AGENT: Address = "0x1111111111111111111111111111111111111111";
const ESCROW: Address = "0x2222222222222222222222222222222222222222";
const NOTE: Address = "0x3333333333333333333333333333333333333333";
const CREDIT_LINE: Address = "0x4444444444444444444444444444444444444444";
const AUCTION: Address = "0x5555555555555555555555555555555555555555";
const CARD: Address = "0x6666666666666666666666666666666666666666";
const USDC: Address = "0x7777777777777777777777777777777777777777";

function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function chainEvent(overrides: Partial<LoanOpenedEvent> & { timestamp: number; logIndex?: number }): LoanOpenedEvent {
  return {
    source: "chain",
    type: "LoanOpened",
    chainId: 84532,
    blockNumber: 100n,
    transactionHash: txHash(overrides.logIndex ?? 0),
    logIndex: overrides.logIndex ?? 0,
    loanId: 1n,
    agentTreasury: AGENT,
    escrow: ESCROW,
    note: NOTE,
    creditLine: CREDIT_LINE,
    auction: AUCTION,
    ...overrides,
  };
}

function agentEvent(overrides: Partial<AgentEvent> & { timestamp: number; id: string }): AgentEvent {
  return {
    source: "agent",
    type: "refusal",
    data: {},
    ...overrides,
  };
}

describe("mergeAndPaginate", () => {
  it("sorts newest-first across both sources", () => {
    const onChain = [chainEvent({ timestamp: 100, logIndex: 1 }), chainEvent({ timestamp: 300, logIndex: 2 })];
    const offChain = [agentEvent({ id: "a", timestamp: 200 })];

    const page = mergeAndPaginate(onChain, offChain);
    expect(page.events.map((e) => e.timestamp)).toEqual([300, 200, 100]);
  });

  it("breaks same-timestamp ties deterministically by id, descending", () => {
    const a = chainEvent({ timestamp: 100, logIndex: 1 });
    const b = chainEvent({ timestamp: 100, logIndex: 2 });
    const page1 = mergeAndPaginate([a, b], []);
    const page2 = mergeAndPaginate([b, a], []);
    expect(page1.events).toEqual(page2.events);
  });

  it("paginates with a limit and returns a nextCursor while more remain", () => {
    const onChain = [0, 1, 2, 3, 4].map((i) => chainEvent({ timestamp: 100 + i, logIndex: i }));
    const page = mergeAndPaginate(onChain, [], { limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(page.events.map((e) => e.timestamp)).toEqual([104, 103]);
    expect(page.nextCursor).toBeDefined();
  });

  it("omits nextCursor on the last page", () => {
    const onChain = [chainEvent({ timestamp: 100, logIndex: 0 })];
    const page = mergeAndPaginate(onChain, [], { limit: 50 });
    expect(page.nextCursor).toBeUndefined();
  });

  it("walking cursors page-by-page reconstructs the full set with no gaps or dupes", () => {
    const onChain = Array.from({ length: 7 }, (_, i) => chainEvent({ timestamp: 100 + i, logIndex: i }));
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = mergeAndPaginate(onChain, [], { limit: 3, cursor });
      seen.push(...page.events.map((e) => e.timestamp));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 104, 105, 106]);
  });

  it("clamps a limit above the max and floors one below the min", () => {
    const onChain = Array.from({ length: 3 }, (_, i) => chainEvent({ timestamp: 100 + i, logIndex: i }));
    expect(mergeAndPaginate(onChain, [], { limit: 10_000 }).events).toHaveLength(3);
    expect(mergeAndPaginate(onChain, [], { limit: 0 }).events).toHaveLength(1);
    expect(mergeAndPaginate(onChain, [], { limit: -5 }).events).toHaveLength(1);
  });
});

describe("decodeCursor", () => {
  it("throws on a malformed cursor", () => {
    expect(() => decodeCursor("not-base64url-with-no-colon")).toThrow(/malformed cursor/);
  });
});

describe("filterEvents", () => {
  const loan1 = chainEvent({ timestamp: 100, logIndex: 0, loanId: 1n });
  const loan2 = chainEvent({ timestamp: 200, logIndex: 1, loanId: 2n });
  const refusal = agentEvent({ id: "r1", timestamp: 150, type: "refusal", loanId: "1" });

  it("filters chain events by loanId (bigint or string query)", () => {
    expect(filterEvents([loan1, loan2], { loanId: 1n })).toEqual([loan1]);
    expect(filterEvents([loan1, loan2], { loanId: "2" })).toEqual([loan2]);
  });

  it("filters agent events by loanId as a string", () => {
    expect(filterEvents([refusal], { loanId: 1n })).toEqual([refusal]);
    expect(filterEvents([refusal], { loanId: 2n })).toEqual([]);
  });

  it("filters by type", () => {
    expect(filterEvents([loan1, refusal], { types: ["refusal"] })).toEqual([refusal]);
  });

  it("filters by sinceSeconds", () => {
    expect(filterEvents([loan1, loan2], { sinceSeconds: 150 })).toEqual([loan2]);
  });

  it("with no query, returns everything unchanged", () => {
    expect(filterEvents([loan1, loan2, refusal], {})).toEqual([loan1, loan2, refusal]);
  });
});

describe("parseAgentEvent / parseAgentEvents", () => {
  it("parses a well-formed event with unix-seconds `at`", () => {
    const parsed = parseAgentEvent({ id: "evt-1", type: "refusal", at: 1_700_000_000, agent: AGENT, loanId: 5 });
    expect(parsed).toEqual({
      source: "agent",
      id: "evt-1",
      type: "refusal",
      agent: AGENT,
      loanId: "5",
      timestamp: 1_700_000_000,
      data: { id: "evt-1", type: "refusal", at: 1_700_000_000, agent: AGENT, loanId: 5 },
    });
  });

  it("accepts a nested `data` payload verbatim", () => {
    const parsed = parseAgentEvent({ id: "evt-2", type: "receipt", ts: 1_700_000_100, data: { payee: "0xabc", amountUsdc: 12 } });
    expect(parsed?.data).toEqual({ payee: "0xabc", amountUsdc: 12 });
  });

  it("accepts `kind`/`eventId`/`timestamp` as aliases", () => {
    const parsed = parseAgentEvent({ eventId: "evt-3", kind: "work_output", timestamp: 1_700_000_200 });
    expect(parsed?.id).toBe("evt-3");
    expect(parsed?.type).toBe("work_output");
  });

  it("converts a millisecond epoch to seconds", () => {
    const parsed = parseAgentEvent({ id: "evt-4", type: "refusal", at: 1_700_000_000_000 });
    expect(parsed?.timestamp).toBe(1_700_000_000);
  });

  it("parses an ISO timestamp string", () => {
    const parsed = parseAgentEvent({ id: "evt-5", type: "refusal", at: "2023-11-14T22:13:20.000Z" });
    expect(parsed?.timestamp).toBe(1_700_000_000);
  });

  it("returns undefined for entries missing type/id/timestamp", () => {
    expect(parseAgentEvent({ type: "refusal", at: 1 })).toBeUndefined(); // no id
    expect(parseAgentEvent({ id: "x", at: 1 })).toBeUndefined(); // no type
    expect(parseAgentEvent({ id: "x", type: "refusal" })).toBeUndefined(); // no timestamp
    expect(parseAgentEvent("not an object")).toBeUndefined();
    expect(parseAgentEvent(null)).toBeUndefined();
    expect(parseAgentEvent([])).toBeUndefined();
  });

  it("drops an unparseable agent field rather than throwing", () => {
    const parsed = parseAgentEvent({ id: "evt-6", type: "refusal", at: 1, agent: "not-an-address" });
    expect(parsed?.agent).toBeUndefined();
  });

  it("parses a bare array feed", () => {
    const events = parseAgentEvents([{ id: "a", type: "refusal", at: 1 }, { id: "b", type: "receipt", at: 2 }]);
    expect(events).toHaveLength(2);
  });

  it("parses a `{ events: [...] }` feed", () => {
    const events = parseAgentEvents({ events: [{ id: "a", type: "refusal", at: 1 }] });
    expect(events).toHaveLength(1);
  });

  it("skips malformed entries but keeps the well-formed ones", () => {
    const events = parseAgentEvents([{ id: "a", type: "refusal", at: 1 }, { garbage: true }, null, "nope"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("a");
  });

  it("returns an empty array for an unrecognizable payload", () => {
    expect(parseAgentEvents({ not: "a feed" })).toEqual([]);
    expect(parseAgentEvents(null)).toEqual([]);
  });
});

describe("readOffChainEvents", () => {
  it("returns an empty array when neither feedUrl nor blobToken is configured", async () => {
    const events = await readOffChainEvents({});
    expect(events).toEqual([]);
  });

  it("fetches and parses a plain JSON feed", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://events.example.com/feed.json");
      return new Response(JSON.stringify([{ id: "a", type: "refusal", at: 1 }]), { status: 200 });
    };
    const events = await readOffChainEvents({ feedUrl: "https://events.example.com/feed.json", fetchImpl: fetchImpl as typeof fetch });
    expect(events).toHaveLength(1);
  });

  it("throws when the feed request fails", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    await expect(
      readOffChainEvents({ feedUrl: "https://events.example.com/feed.json", fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/failed with status 500/);
  });

  it("lists and fetches every blob under the prefix", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u === "https://blob.example.com?prefix=events%2F") {
        return new Response(
          JSON.stringify({ blobs: [{ url: "https://blob.example.com/events/1.json" }, { url: "https://blob.example.com/events/2.json" }] }),
          { status: 200 },
        );
      }
      if (u === "https://blob.example.com/events/1.json") {
        return new Response(JSON.stringify([{ id: "a", type: "refusal", at: 1 }]), { status: 200 });
      }
      if (u === "https://blob.example.com/events/2.json") {
        return new Response(JSON.stringify({ id: "b", type: "receipt", at: 2 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const events = await readOffChainEvents({
      blobToken: "vercel_blob_rw_x",
      blobApiUrl: "https://blob.example.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(events.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(calls[0]).toBe("https://blob.example.com?prefix=events%2F"); // list call happens before per-blob fetches
  });

  it("merges a feed URL and a blob listing together", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://events.example.com/feed.json") {
        return new Response(JSON.stringify([{ id: "feed-1", type: "refusal", at: 1 }]), { status: 200 });
      }
      if (u.startsWith("https://blob.example.com")) {
        return new Response(JSON.stringify({ blobs: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const events = await readOffChainEvents({
      feedUrl: "https://events.example.com/feed.json",
      blobToken: "token",
      blobApiUrl: "https://blob.example.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(events.map((e) => e.id)).toEqual(["feed-1"]);
  });
});

describe("estimateBlockAtTimestamp", () => {
  it("estimates blocksAgo at ~2s/block, widened by the safety margin", () => {
    // 1000s ago at 2s/block = 500 blocks; * 1.2 safety margin = 600.
    const estimate = estimateBlockAtTimestamp(10_000n, 2_000_000, 2_000_000 - 1000);
    expect(estimate).toBe(10_000n - 600n);
  });

  it("returns the same block for a target at or after the latest timestamp", () => {
    expect(estimateBlockAtTimestamp(10_000n, 2_000_000, 2_000_000)).toBe(10_000n);
    expect(estimateBlockAtTimestamp(10_000n, 2_000_000, 2_100_000)).toBe(10_000n);
  });

  it("never returns a negative block number", () => {
    expect(estimateBlockAtTimestamp(100n, 1_000, 0)).toBe(0n);
  });
});

// -------------------------------------------------------------------------------------------
// A fake ChainLogsClient for readOnChainEvents / createEventsSource tests
// -------------------------------------------------------------------------------------------

function keyOf(address: Address, eventName: string): string {
  return `${address.toLowerCase()}:${eventName}`;
}

function makeFakeChainLogsClient(opts: {
  latestBlock: bigint;
  latestTimestamp: number;
  logsByKey: Map<string, ChainLogEntry[]>;
  blockTimestamps?: Map<string, number>;
}): ChainLogsClient & { calls: { address: Address; eventName: string; args?: Record<string, unknown> }[] } {
  const calls: { address: Address; eventName: string; args?: Record<string, unknown> }[] = [];
  return {
    calls,
    async getBlockNumber() {
      return opts.latestBlock;
    },
    async getBlock({ blockNumber }) {
      if (blockNumber === opts.latestBlock) return { timestamp: BigInt(opts.latestTimestamp) };
      const t = opts.blockTimestamps?.get(blockNumber.toString());
      if (t === undefined) throw new Error(`fake client: no timestamp stubbed for block ${blockNumber}`);
      return { timestamp: BigInt(t) };
    },
    async getLogs({ address, event, args }) {
      calls.push({ address, eventName: event.name, args });
      return opts.logsByKey.get(keyOf(address, event.name)) ?? [];
    },
  };
}

function fakeLog(overrides: Partial<ChainLogEntry> & { eventName: string; args: Record<string, unknown> }): ChainLogEntry {
  return {
    blockNumber: 100n,
    transactionHash: txHash(overrides.logIndex ?? 0),
    logIndex: 0,
    ...overrides,
  };
}

describe("readOnChainEvents", () => {
  const resolveLoanContracts = async (loanId: bigint): Promise<LoanContractAddresses | undefined> =>
    loanId === 1n ? { escrow: ESCROW, note: NOTE, creditLine: CREDIT_LINE, auction: AUCTION, agentCard: CARD } : undefined;
  const resolveUsdc = async (): Promise<Address> => USDC;

  it("reads unscoped hub lifecycle events only", async () => {
    const logs = new Map<string, ChainLogEntry[]>();
    logs.set(keyOf(HUB, "LoanOpened"), [
      fakeLog({ eventName: "LoanOpened", args: { loanId: 1n, agentTreasury: AGENT, escrow: ESCROW, note: NOTE, creditLine: CREDIT_LINE, auction: AUCTION }, blockNumber: 100n }),
    ]);
    const client = makeFakeChainLogsClient({ latestBlock: 100n, latestTimestamp: 1_700_000_000, logsByKey: logs });
    const ctx: ChainEventsContext = { client, hub: HUB, chainId: 84532, resolveLoanContracts, resolveUsdc };

    const events = await readOnChainEvents(ctx, {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "LoanOpened", loanId: 1n, timestamp: 1_700_000_000 });

    // Loan-scoped contracts were never queried without a loanId.
    expect(client.calls.some((c) => c.address === ESCROW)).toBe(false);
  });

  it("scoping to a loanId also reads that loan's Drawn/Harvested/Distributed/Claimed/card transfers", async () => {
    const logs = new Map<string, ChainLogEntry[]>();
    logs.set(keyOf(CREDIT_LINE, "Drawn"), [fakeLog({ eventName: "Drawn", args: { amount: 900n, period: 1n, remainingInPeriod: 0n }, blockNumber: 100n })]);
    logs.set(keyOf(ESCROW, "Harvested"), [
      fakeLog({ eventName: "Harvested", args: { wethIn: 1n, usdcOut: 50_000_000n, toNotes: 40_000_000n, toTreasury: 10_000_000n }, blockNumber: 100n }),
    ]);
    logs.set(keyOf(NOTE, "Distributed"), [fakeLog({ eventName: "Distributed", args: { from: ESCROW, amount: 40_000_000n, totalRepaid: 40_000_000n }, blockNumber: 100n })]);
    logs.set(keyOf(NOTE, "Claimed"), [fakeLog({ eventName: "Claimed", args: { holder: AGENT, amount: 10_000_000n }, blockNumber: 100n })]);
    logs.set(keyOf(USDC, "Transfer"), [fakeLog({ eventName: "Transfer", args: { from: CARD, to: AGENT, value: 900n }, blockNumber: 100n })]);

    const client = makeFakeChainLogsClient({ latestBlock: 100n, latestTimestamp: 1_700_000_000, logsByKey: logs });
    const ctx: ChainEventsContext = { client, hub: HUB, chainId: 84532, resolveLoanContracts, resolveUsdc };

    const events = await readOnChainEvents(ctx, { loanId: 1n });
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(["CardTransfer", "Claimed", "Distributed", "Drawn", "Harvested"]);
    for (const e of events) expect((e as OnChainEvent & { loanId?: bigint }).loanId).toBe(1n);

    const harvested = events.find((e): e is HarvestedEvent => e.type === "Harvested");
    expect(harvested?.usdcOut).toBe(50_000_000n);
  });

  it("skips loan-scoped reads entirely when the loan doesn't exist", async () => {
    const client = makeFakeChainLogsClient({ latestBlock: 100n, latestTimestamp: 1_700_000_000, logsByKey: new Map() });
    const ctx: ChainEventsContext = { client, hub: HUB, chainId: 84532, resolveLoanContracts, resolveUsdc };

    const events = await readOnChainEvents(ctx, { loanId: 999n });
    expect(events).toEqual([]);
    expect(client.calls.some((c) => c.address === CREDIT_LINE)).toBe(false);
  });

  it("only queries the requested types", async () => {
    const client = makeFakeChainLogsClient({ latestBlock: 100n, latestTimestamp: 1_700_000_000, logsByKey: new Map() });
    const ctx: ChainEventsContext = { client, hub: HUB, chainId: 84532, resolveLoanContracts, resolveUsdc };

    await readOnChainEvents(ctx, { loanId: 1n, types: ["Harvested"] });
    const eventNames = client.calls.map((c) => c.eventName).sort();
    expect(eventNames).toEqual(["Harvested"]);
  });

  it("drops events before sinceSeconds even when the block-estimate over-fetches", async () => {
    const logs = new Map<string, ChainLogEntry[]>();
    logs.set(keyOf(HUB, "LoanRepaid"), [
      fakeLog({ eventName: "LoanRepaid", args: { loanId: 1n, totalRepaid: 1n }, blockNumber: 90n, logIndex: 1 }),
      fakeLog({ eventName: "LoanRepaid", args: { loanId: 1n, totalRepaid: 2n }, blockNumber: 95n, logIndex: 2 }),
    ]);
    const client = makeFakeChainLogsClient({
      latestBlock: 100n,
      latestTimestamp: 1_700_001_000,
      logsByKey: logs,
      blockTimestamps: new Map([
        ["90", 1_700_000_000],
        ["95", 1_700_000_500],
      ]),
    });
    const ctx: ChainEventsContext = { client, hub: HUB, chainId: 84532, resolveLoanContracts, resolveUsdc };

    const events = await readOnChainEvents(ctx, { types: ["LoanRepaid"], sinceSeconds: 1_700_000_300 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ totalRepaid: 2n });
  });
});

describe("createEventsSource", () => {
  it("merges on-chain and off-chain reads into one page", async () => {
    const logs = new Map<string, ChainLogEntry[]>();
    logs.set(keyOf(HUB, "LoanOpened"), [
      fakeLog({ eventName: "LoanOpened", args: { loanId: 1n, agentTreasury: AGENT, escrow: ESCROW, note: NOTE, creditLine: CREDIT_LINE, auction: AUCTION }, blockNumber: 100n }),
    ]);
    const client = makeFakeChainLogsClient({ latestBlock: 100n, latestTimestamp: 1_700_000_500, logsByKey: logs });

    const fetchImpl = async () => new Response(JSON.stringify([{ id: "r1", type: "refusal", at: 1_700_000_600 }]), { status: 200 });

    const source = createEventsSource({
      client,
      hub: HUB,
      chainId: 84532,
      resolveLoanContracts: async () => undefined,
      resolveUsdc: async () => USDC,
      feedUrl: "https://events.example.com/feed.json",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const page = await source.list();
    expect(page.events.map((e) => e.type)).toEqual(["refusal", "LoanOpened"]);
  });

  it("with no off-chain sources configured, returns on-chain events only", async () => {
    const client = makeFakeChainLogsClient({ latestBlock: 100n, latestTimestamp: 1_700_000_500, logsByKey: new Map() });
    const source = createEventsSource({
      client,
      hub: HUB,
      chainId: 84532,
      resolveLoanContracts: async () => undefined,
      resolveUsdc: async () => USDC,
    });
    const page = await source.list();
    expect(page.events).toEqual([]);
  });
});
