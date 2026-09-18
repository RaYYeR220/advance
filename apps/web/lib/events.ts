import type { AbiEvent, Address, Hex, PublicClient } from "viem";
import { getAbiItem } from "viem";
import {
  advanceHubAbi,
  creditLineAbi,
  readHubConfig,
  readLoanRecord,
  revenueEscrowAbi,
  revenueNoteAbi,
  loanStatusFromIndex,
  type ChainContext,
} from "@advance/sdk";
import { isTxHash } from "./format";
import { getPublicClient, type SupportedChainId, type WebEnv } from "./env";

/**
 * Real agent activity, merged from two independent sources and returned as one
 * newest-first, paginated feed:
 *  - on-chain logs (`LoanOpened`/`LoanActivated`/`LoanRepaid`/`LoanDefaulted`/`LoanFailed`
 *    from the hub; `Drawn`/`Harvested`/`Distributed`/`Claimed`/card USDC transfers scoped to
 *    one loan's own contracts), read live with viem;
 *  - off-chain agent events (gateway refusals, x402 receipts, work outputs) from a JSON feed
 *    URL and/or a Vercel Blob listing — both optional; neither configured means on-chain only.
 *
 * There is no indexer. Hub-level events can be read unscoped (bounded by `sinceSeconds`), but
 * the per-loan contract events (`Drawn`/`Harvested`/`Distributed`/`Claimed`/card transfers)
 * require `loanId` — there is no way to enumerate "every such event for every loan" without
 * iterating every loan's own contracts one at a time (see `data.ts`'s `getEconomy`, which does
 * exactly that, one loan at a time).
 */

// ---------------------------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------------------------

export type OnChainEventType =
  | "LoanOpened"
  | "LoanActivated"
  | "LoanRepaid"
  | "LoanDefaulted"
  | "LoanFailed"
  | "Drawn"
  | "Harvested"
  | "Distributed"
  | "Claimed"
  | "CardTransfer";

interface OnChainEventCommon {
  source: "chain";
  chainId: SupportedChainId;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  timestamp: number;
}

export interface LoanOpenedEvent extends OnChainEventCommon {
  type: "LoanOpened";
  loanId: bigint;
  agentTreasury: Address;
  escrow: Address;
  note: Address;
  creditLine: Address;
  auction: Address;
}

export interface LoanActivatedEvent extends OnChainEventCommon {
  type: "LoanActivated";
  loanId: bigint;
  principal: bigint;
}

export interface LoanRepaidEvent extends OnChainEventCommon {
  type: "LoanRepaid";
  loanId: bigint;
  totalRepaid: bigint;
}

export interface LoanDefaultedEvent extends OnChainEventCommon {
  type: "LoanDefaulted";
  loanId: bigint;
  lastRevenueAt: bigint;
}

export interface LoanFailedEvent extends OnChainEventCommon {
  type: "LoanFailed";
  loanId: bigint;
}

/** `Drawn`/`Harvested`/`Distributed`/`Claimed`/`CardTransfer` never carry a `loanId` in their
 * own log — it's attached from the query that scoped the read to one loan's contracts. */
export interface DrawnEvent extends OnChainEventCommon {
  type: "Drawn";
  loanId?: bigint;
  amount: bigint;
  period: bigint;
  remainingInPeriod: bigint;
}

export interface HarvestedEvent extends OnChainEventCommon {
  type: "Harvested";
  loanId?: bigint;
  wethIn: bigint;
  usdcOut: bigint;
  toNotes: bigint;
  toTreasury: bigint;
}

export interface DistributedEvent extends OnChainEventCommon {
  type: "Distributed";
  loanId?: bigint;
  from: Address;
  amount: bigint;
  totalRepaid: bigint;
}

export interface ClaimedEvent extends OnChainEventCommon {
  type: "Claimed";
  loanId?: bigint;
  holder: Address;
  amount: bigint;
}

export interface CardTransferEvent extends OnChainEventCommon {
  type: "CardTransfer";
  loanId?: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

export type OnChainEvent =
  | LoanOpenedEvent
  | LoanActivatedEvent
  | LoanRepaidEvent
  | LoanDefaultedEvent
  | LoanFailedEvent
  | DrawnEvent
  | HarvestedEvent
  | DistributedEvent
  | ClaimedEvent
  | CardTransferEvent;

/** An off-chain agent event (gateway refusal, x402 receipt, work output, ...). `type` is
 * free-form — the agents runtime that writes the feed defines its own vocabulary; the merge
 * layer only needs `id`/`type`/`timestamp` to sort and paginate. */
export interface AgentEvent {
  source: "agent";
  id: string;
  type: string;
  agent?: Address;
  loanId?: string;
  timestamp: number;
  data: Record<string, unknown>;
  /** The transaction this event is evidence of (e.g. a reverted on-chain draw behind a
   * refusal, or the settlement behind a receipt), when the runtime attached one. Kept
   * separate from `data` so callers can link to it without depending on the runtime's own
   * field naming inside `data`. `undefined` when the event has none (e.g. a refusal caught
   * before it ever reached the chain). */
  txHash?: Hex;
}

export type MergedEvent = OnChainEvent | AgentEvent;

// ---------------------------------------------------------------------------------------------
// Ordering, cursors, pagination — pure, no I/O
// ---------------------------------------------------------------------------------------------

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function eventId(e: MergedEvent): string {
  return e.source === "chain" ? `${e.transactionHash}:${e.logIndex}` : e.id;
}

/** Newest-first; ties (same-block chain events, or a chain/agent event sharing a timestamp)
 * break on `eventId` descending, so the order is deterministic regardless of input order. */
function compareDesc(a: MergedEvent, b: MergedEvent): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  const idA = eventId(a);
  const idB = eventId(b);
  return idA < idB ? 1 : idA > idB ? -1 : 0;
}

interface DecodedCursor {
  timestamp: number;
  id: string;
}

function encodeCursor(e: MergedEvent): string {
  return Buffer.from(`${e.timestamp}:${eventId(e)}`, "utf8").toString("base64url");
}

/** Throws on a cursor that isn't well-formed — callers at the edge (the API route) should
 * validate cursors before this point and turn a throw into a 400, rather than this module
 * silently treating a corrupt cursor as "start from the top". */
export function decodeCursor(cursor: string): DecodedCursor {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.indexOf(":");
  if (sep < 0) throw new Error(`events: malformed cursor "${cursor}"`);
  const timestamp = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(timestamp) || id.length === 0) {
    throw new Error(`events: malformed cursor "${cursor}"`);
  }
  return { timestamp, id };
}

/** True while `e` is at-or-before the cursor's position in the newest-first ordering (i.e.
 * hasn't yet reached the "strictly after the cursor" page-2 starting point). */
function isAtOrBeforeCursor(e: MergedEvent, cursor: DecodedCursor): boolean {
  if (e.timestamp !== cursor.timestamp) return e.timestamp > cursor.timestamp;
  return eventId(e) >= cursor.id;
}

export interface EventsPage {
  events: MergedEvent[];
  nextCursor?: string;
}

/** Merges already-fetched on-chain and off-chain events into one newest-first, paginated
 * page. Pure and synchronous — every network/decoding concern lives upstream of this, so it's
 * exercised directly with plain fixtures in tests. */
export function mergeAndPaginate(
  onChain: readonly OnChainEvent[],
  offChain: readonly AgentEvent[],
  opts: { limit?: number; cursor?: string } = {},
): EventsPage {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
  const sorted = [...onChain, ...offChain].sort(compareDesc);

  let start = 0;
  if (opts.cursor) {
    const cursor = decodeCursor(opts.cursor);
    const idx = sorted.findIndex((e) => !isAtOrBeforeCursor(e, cursor));
    start = idx === -1 ? sorted.length : idx;
  }

  const page = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last) : undefined;

  return { events: page, nextCursor };
}

// ---------------------------------------------------------------------------------------------
// Filtering — pure
// ---------------------------------------------------------------------------------------------

export interface EventsQuery {
  loanId?: bigint | string;
  types?: readonly string[];
  /** Unix seconds; only events at or after this time. */
  sinceSeconds?: number;
  limit?: number;
  cursor?: string;
}

function matchesLoanId<T extends MergedEvent>(e: T, loanId: string): boolean {
  if (e.source === "chain") return e.loanId !== undefined && e.loanId.toString() === loanId;
  return e.loanId === loanId;
}

/** Filters a homogeneous list of events by loan id / type / recency — used for the off-chain
 * side of a query, whose events this module never fetches pre-scoped (unlike the on-chain
 * side, which is queried pre-scoped by `readOnChainEvents`). */
export function filterEvents<T extends MergedEvent>(
  events: readonly T[],
  query: Pick<EventsQuery, "loanId" | "types" | "sinceSeconds">,
): T[] {
  const loanId = query.loanId === undefined ? undefined : query.loanId.toString();
  return events.filter((e) => {
    if (loanId !== undefined && !matchesLoanId(e, loanId)) return false;
    if (query.types && !query.types.includes(e.type)) return false;
    if (query.sinceSeconds !== undefined && e.timestamp < query.sinceSeconds) return false;
    return true;
  });
}

const ON_CHAIN_EVENT_TYPES: readonly OnChainEventType[] = [
  "LoanOpened",
  "LoanActivated",
  "LoanRepaid",
  "LoanDefaulted",
  "LoanFailed",
  "Drawn",
  "Harvested",
  "Distributed",
  "Claimed",
  "CardTransfer",
];

function isOnChainEventType(type: string): type is OnChainEventType {
  return (ON_CHAIN_EVENT_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------------------------
// Off-chain feed: JSON URL and/or Vercel Blob listing
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function toTimestampSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: anything past year ~5138 in seconds is almost certainly milliseconds.
    return value > 100_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    if (/^-?\d+$/.test(value.trim())) return toTimestampSeconds(Number(value));
    const parsedMs = Date.parse(value);
    if (!Number.isNaN(parsedMs)) return Math.floor(parsedMs / 1000);
  }
  return undefined;
}

/**
 * Parses one off-chain agent event from an untrusted JSON payload. Tolerant of a few
 * equivalent field names (`at`/`timestamp`/`ts`, `id`/`eventId`, `agent`/`agentTreasury`) so a
 * variety of writer shapes work without a single rigid schema. Returns `undefined` — never
 * throws — for anything that isn't recognizably an event, so one malformed entry in a feed
 * doesn't take down the whole page.
 */
export function parseAgentEvent(raw: unknown): AgentEvent | undefined {
  if (!isRecord(raw)) return undefined;

  const type = raw.type ?? raw.kind;
  if (typeof type !== "string" || type.length === 0) return undefined;

  const idRaw = raw.id ?? raw.eventId;
  if (typeof idRaw !== "string" || idRaw.length === 0) return undefined;

  const timestamp = toTimestampSeconds(raw.at ?? raw.timestamp ?? raw.ts);
  if (timestamp === undefined) return undefined;

  const agentRaw = raw.agent ?? raw.agentTreasury;
  const agent = typeof agentRaw === "string" && ADDRESS_PATTERN.test(agentRaw) ? (agentRaw as Address) : undefined;

  const loanIdRaw = raw.loanId;
  const loanId = loanIdRaw === undefined || loanIdRaw === null ? undefined : String(loanIdRaw);

  const data = isRecord(raw.data) ? raw.data : raw;

  const txHashRaw = raw.txHash;
  const txHash = typeof txHashRaw === "string" && isTxHash(txHashRaw) ? txHashRaw : undefined;

  return { source: "agent", id: idRaw, type, agent, loanId, timestamp, data, txHash };
}

/** Parses a whole feed payload — a bare array, or `{ events: [...] }` — skipping any entry
 * `parseAgentEvent` can't make sense of rather than failing the whole feed. */
export function parseAgentEvents(raw: unknown): AgentEvent[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.events) ? raw.events : undefined;
  if (!list) return [];
  const events: AgentEvent[] = [];
  for (const item of list) {
    const parsed = parseAgentEvent(item);
    if (parsed) events.push(parsed);
  }
  return events;
}

export interface OffChainFeedOptions {
  feedUrl?: string;
  blobToken?: string;
  /** Vercel Blob's list API base — overridable for tests. */
  blobApiUrl?: string;
  /** Prefix passed to the Blob list call, so only this deployment's event files are listed. */
  blobPrefix?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BLOB_API_URL = "https://blob.vercel-storage.com";
const DEFAULT_BLOB_PREFIX = "events/";

interface BlobListEntry {
  url: string;
}

function isBlobListResponse(value: unknown): value is { blobs: BlobListEntry[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.blobs) &&
    value.blobs.every((b) => isRecord(b) && typeof b.url === "string")
  );
}

/** Lists every blob under `blobPrefix` via Vercel Blob's plain REST listing endpoint (Bearer
 * token, no `@vercel/blob` SDK dependency — keeps this fetch-testable with a fake `fetchImpl`
 * like every other seam in this module) and parses each one as a feed payload. */
async function fetchBlobEvents(opts: OffChainFeedOptions & { blobToken: string }): Promise<AgentEvent[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.blobApiUrl ?? DEFAULT_BLOB_API_URL;
  const prefix = opts.blobPrefix ?? DEFAULT_BLOB_PREFIX;

  const listRes = await fetchImpl(`${apiUrl}?prefix=${encodeURIComponent(prefix)}`, {
    headers: { authorization: `Bearer ${opts.blobToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`events: blob list request failed with status ${listRes.status}`);
  }
  const listBody: unknown = await listRes.json();
  if (!isBlobListResponse(listBody)) return [];

  const perBlob = await Promise.all(
    listBody.blobs.map(async (blob) => {
      const res = await fetchImpl(blob.url);
      if (!res.ok) return [];
      const body: unknown = await res.json();
      // Each blob is either a feed payload (array / `{ events: [...] }`) or one bare event —
      // the agents runtime may write either shape (a batch file vs. one file per event).
      if (Array.isArray(body) || (isRecord(body) && Array.isArray(body.events))) {
        return parseAgentEvents(body);
      }
      const single = parseAgentEvent(body);
      return single ? [single] : [];
    }),
  );
  return perBlob.flat();
}

async function fetchJsonFeed(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`events: feed request to ${url} failed with status ${res.status}`);
  }
  return res.json();
}

/** Reads whichever off-chain sources are configured. Neither `feedUrl` nor `blobToken` set
 * means "on-chain only" — an empty array, not an error (matches the plan: both are optional). */
export async function readOffChainEvents(opts: OffChainFeedOptions): Promise<AgentEvent[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const reads: Promise<AgentEvent[]>[] = [];
  if (opts.feedUrl) reads.push(fetchJsonFeed(opts.feedUrl, fetchImpl).then(parseAgentEvents));
  if (opts.blobToken) reads.push(fetchBlobEvents({ ...opts, blobToken: opts.blobToken }));
  if (reads.length === 0) return [];
  const results = await Promise.all(reads);
  return results.flat();
}

// ---------------------------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------------------------

export interface ChainLogEntry {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

/** The slice of a viem `PublicClient` this module needs — small and structural on purpose, so
 * tests fake it directly instead of standing up a real chain (see the plan's constraint: no
 * contracts are deployed yet). `toChainLogsClient` adapts a real `PublicClient` to it. */
export interface ChainLogsClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getLogs(args: {
    address: Address;
    event: AbiEvent;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainLogEntry[]>;
}

export function toChainLogsClient(client: PublicClient): ChainLogsClient {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: (args) => client.getBlock(args),
    async getLogs(args) {
      const logs = await client.getLogs(args);
      return logs.map((log) => {
        if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
          // `getLogs` only ever returns finalized logs, so these are non-null in practice;
          // failing loudly here beats silently coercing a pending-shaped log into a fake one.
          throw new Error("events: getLogs returned an unmined log (missing blockNumber/transactionHash/logIndex)");
        }
        return {
          eventName: String(log.eventName ?? args.event.name),
          args: (log.args ?? {}) as Record<string, unknown>,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        };
      });
    },
  };
}

const BLOCK_TIME_SECONDS = 2; // Base mainnet and Base Sepolia both target ~2s blocks
/** Widens the estimated `fromBlock` this far further into the past than a constant block time
 * alone would predict, so real (non-constant) block-time drift never makes the estimate land
 * after the block actually being looked for — over-fetching a bit is cheap; under-fetching
 * silently drops real history. */
const BLOCK_ESTIMATE_SAFETY_MARGIN = 1.2;

/** Approximates the block number at `targetTimestamp` from one known `(latestBlock,
 * latestTimestamp)` anchor, assuming a constant block time. There is no exact
 * timestamp-to-block index available without either an archive-node binary search or a real
 * indexer — this is a documented approximation, deliberately widened (never narrowed) by
 * `BLOCK_ESTIMATE_SAFETY_MARGIN`. Never returns a negative block number. */
export function estimateBlockAtTimestamp(latestBlock: bigint, latestTimestamp: number, targetTimestamp: number): bigint {
  const secondsAgo = Math.max(0, latestTimestamp - targetTimestamp);
  const blocksAgo = BigInt(Math.ceil((secondsAgo / BLOCK_TIME_SECONDS) * BLOCK_ESTIMATE_SAFETY_MARGIN));
  return blocksAgo >= latestBlock ? 0n : latestBlock - blocksAgo;
}

export interface LoanContractAddresses {
  escrow: Address;
  note: Address;
  creditLine: Address;
  auction: Address;
  agentCard: Address;
}

export interface ChainEventsContext {
  client: ChainLogsClient;
  hub: Address;
  chainId: SupportedChainId;
  /** Resolves a loan id to its side-contract addresses plus its card — needed to scope
   * `Drawn`/`Harvested`/`Distributed`/`Claimed`/card-transfer reads, none of which carry a
   * `loanId` in their own log. `undefined` for a loan id that never opened a loan. */
  resolveLoanContracts: (loanId: bigint) => Promise<LoanContractAddresses | undefined>;
  /** Resolves the hub's USDC address, for scoping the card-transfer read. */
  resolveUsdc: () => Promise<Address>;
}

export interface OnChainEventsQuery {
  loanId?: bigint;
  types?: readonly OnChainEventType[];
  sinceSeconds?: number;
}

const HUB_EVENT_NAMES = ["LoanOpened", "LoanActivated", "LoanRepaid", "LoanDefaulted", "LoanFailed"] as const;
/** No `sinceSeconds` and no `loanId` (an unscoped, whole-hub query) still needs *some* bound —
 * this is how far back an unscoped read looks by default. */
const UNSCOPED_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;

const ERC20_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const satisfies AbiEvent;

function toOnChainEvent(entry: { log: ChainLogEntry; loanId?: bigint }, chainId: SupportedChainId, timestamp: number): OnChainEvent | undefined {
  const { log, loanId } = entry;
  const common = {
    source: "chain" as const,
    chainId,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    timestamp,
  };
  switch (log.eventName) {
    case "LoanOpened":
      return {
        ...common,
        type: "LoanOpened",
        loanId: log.args.loanId as bigint,
        agentTreasury: log.args.agentTreasury as Address,
        escrow: log.args.escrow as Address,
        note: log.args.note as Address,
        creditLine: log.args.creditLine as Address,
        auction: log.args.auction as Address,
      };
    case "LoanActivated":
      return { ...common, type: "LoanActivated", loanId: log.args.loanId as bigint, principal: log.args.principal as bigint };
    case "LoanRepaid":
      return { ...common, type: "LoanRepaid", loanId: log.args.loanId as bigint, totalRepaid: log.args.totalRepaid as bigint };
    case "LoanDefaulted":
      return { ...common, type: "LoanDefaulted", loanId: log.args.loanId as bigint, lastRevenueAt: log.args.lastRevenueAt as bigint };
    case "LoanFailed":
      return { ...common, type: "LoanFailed", loanId: log.args.loanId as bigint };
    case "Drawn":
      return {
        ...common,
        type: "Drawn",
        loanId,
        amount: log.args.amount as bigint,
        period: log.args.period as bigint,
        remainingInPeriod: log.args.remainingInPeriod as bigint,
      };
    case "Harvested":
      return {
        ...common,
        type: "Harvested",
        loanId,
        wethIn: log.args.wethIn as bigint,
        usdcOut: log.args.usdcOut as bigint,
        toNotes: log.args.toNotes as bigint,
        toTreasury: log.args.toTreasury as bigint,
      };
    case "Distributed":
      return {
        ...common,
        type: "Distributed",
        loanId,
        from: log.args.from as Address,
        amount: log.args.amount as bigint,
        totalRepaid: log.args.totalRepaid as bigint,
      };
    case "Claimed":
      return { ...common, type: "Claimed", loanId, holder: log.args.holder as Address, amount: log.args.amount as bigint };
    case "Transfer":
      return { ...common, type: "CardTransfer", loanId, from: log.args.from as Address, to: log.args.to as Address, value: log.args.value as bigint };
    default:
      return undefined;
  }
}

async function timestampsByBlock(client: ChainLogsClient, logs: readonly ChainLogEntry[]): Promise<Map<string, number>> {
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber.toString()))];
  const entries = await Promise.all(
    uniqueBlocks.map(async (key): Promise<readonly [string, number]> => {
      const block = await client.getBlock({ blockNumber: BigInt(key) });
      return [key, Number(block.timestamp)];
    }),
  );
  return new Map(entries);
}

/**
 * Reads real on-chain events for `query`. Unscoped (no `loanId`): hub-level loan lifecycle
 * events only, bounded by `sinceSeconds` (or a 30-day default). Scoped to one `loanId`: the
 * same lifecycle events filtered to it, plus that loan's own `Drawn`/`Harvested`/`Distributed`/
 * `Claimed`/card-transfer history (see the module doc for why unscoped can't include those).
 */
export async function readOnChainEvents(ctx: ChainEventsContext, query: OnChainEventsQuery): Promise<OnChainEvent[]> {
  const latestBlock = await ctx.client.getBlockNumber();
  const latestBlockInfo = await ctx.client.getBlock({ blockNumber: latestBlock });
  const latestTimestamp = Number(latestBlockInfo.timestamp);

  const sinceSeconds = query.sinceSeconds ?? latestTimestamp - UNSCOPED_LOOKBACK_SECONDS;
  const fromBlock = estimateBlockAtTimestamp(latestBlock, latestTimestamp, sinceSeconds);

  const wantsType = (name: OnChainEventType): boolean => !query.types || query.types.includes(name);

  const entries: { log: ChainLogEntry; loanId?: bigint }[] = [];

  const hubEventNames = HUB_EVENT_NAMES.filter(wantsType);
  if (hubEventNames.length > 0) {
    const perEvent = await Promise.all(
      hubEventNames.map((name) =>
        ctx.client.getLogs({
          address: ctx.hub,
          event: getAbiItem({ abi: advanceHubAbi, name }) as AbiEvent,
          args: query.loanId !== undefined ? { loanId: query.loanId } : undefined,
          fromBlock,
          toBlock: latestBlock,
        }),
      ),
    );
    for (const logs of perEvent) for (const log of logs) entries.push({ log });
  }

  if (query.loanId !== undefined) {
    const loanContracts = await ctx.resolveLoanContracts(query.loanId);
    if (loanContracts) {
      const reads: Promise<ChainLogEntry[]>[] = [];
      if (wantsType("Drawn")) {
        reads.push(
          ctx.client.getLogs({
            address: loanContracts.creditLine,
            event: getAbiItem({ abi: creditLineAbi, name: "Drawn" }) as AbiEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
        );
      }
      if (wantsType("Harvested")) {
        reads.push(
          ctx.client.getLogs({
            address: loanContracts.escrow,
            event: getAbiItem({ abi: revenueEscrowAbi, name: "Harvested" }) as AbiEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
        );
      }
      if (wantsType("Distributed")) {
        reads.push(
          ctx.client.getLogs({
            address: loanContracts.note,
            event: getAbiItem({ abi: revenueNoteAbi, name: "Distributed" }) as AbiEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
        );
      }
      if (wantsType("Claimed")) {
        reads.push(
          ctx.client.getLogs({
            address: loanContracts.note,
            event: getAbiItem({ abi: revenueNoteAbi, name: "Claimed" }) as AbiEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
        );
      }
      if (wantsType("CardTransfer")) {
        const usdc = await ctx.resolveUsdc();
        reads.push(
          ctx.client.getLogs({
            address: usdc,
            event: ERC20_TRANSFER_EVENT,
            args: { from: loanContracts.agentCard },
            fromBlock,
            toBlock: latestBlock,
          }),
        );
      }
      const perContract = await Promise.all(reads);
      for (const logs of perContract) for (const log of logs) entries.push({ log, loanId: query.loanId });
    }
  }

  const timestamps = await timestampsByBlock(ctx.client, entries.map((e) => e.log));

  const events: OnChainEvent[] = [];
  for (const entry of entries) {
    const timestamp = timestamps.get(entry.log.blockNumber.toString());
    if (timestamp === undefined || timestamp < sinceSeconds) continue;
    const built = toOnChainEvent(entry, ctx.chainId, timestamp);
    if (built) events.push(built);
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// EventsSource: the merged, paginated read `data.ts` and the API route both call
// ---------------------------------------------------------------------------------------------

export interface EventsSource {
  list(query?: EventsQuery): Promise<EventsPage>;
}

export interface EventsSourceOptions extends OffChainFeedOptions {
  client: ChainLogsClient;
  hub: Address;
  chainId: SupportedChainId;
  resolveLoanContracts: (loanId: bigint) => Promise<LoanContractAddresses | undefined>;
  resolveUsdc: () => Promise<Address>;
}

/** Builds an `EventsSource` from fully-injected dependencies — the seam tests use. Production
 * code should generally use `createLiveEventsSource`, which wires these from a real chain. */
export function createEventsSource(opts: EventsSourceOptions): EventsSource {
  const ctx: ChainEventsContext = {
    client: opts.client,
    hub: opts.hub,
    chainId: opts.chainId,
    resolveLoanContracts: opts.resolveLoanContracts,
    resolveUsdc: opts.resolveUsdc,
  };

  return {
    async list(query = {}): Promise<EventsPage> {
      const loanId = typeof query.loanId === "bigint" || query.loanId === undefined ? query.loanId : BigInt(query.loanId);
      const onChainTypes = query.types?.filter(isOnChainEventType);

      const [onChain, offChainRaw] = await Promise.all([
        readOnChainEvents(ctx, { loanId, types: onChainTypes, sinceSeconds: query.sinceSeconds }),
        readOffChainEvents(opts),
      ]);

      const offChain = filterEvents(offChainRaw, { loanId: query.loanId, types: query.types, sinceSeconds: query.sinceSeconds });

      return mergeAndPaginate(onChain, offChain, { limit: query.limit, cursor: query.cursor });
    },
  };
}

/** The production `EventsSource`: a real viem `PublicClient` for on-chain reads, and
 * `webEnv`'s `eventsUrl`/`blobReadWriteToken` for the off-chain side (either, both, or neither
 * — neither means on-chain only). */
export function createLiveEventsSource(
  webEnv: Pick<WebEnv, "chainId" | "rpcUrl" | "hub" | "eventsUrl" | "blobReadWriteToken">,
): EventsSource {
  const publicClient = getPublicClient(webEnv);
  const chainContext: ChainContext = { publicClient, hub: webEnv.hub };

  let usdcPromise: Promise<Address> | undefined;

  return createEventsSource({
    client: toChainLogsClient(publicClient),
    hub: webEnv.hub,
    chainId: webEnv.chainId,
    resolveLoanContracts: async (loanId) => {
      const record = await readLoanRecord(chainContext, loanId);
      if (loanStatusFromIndex(record.status) === "None") return undefined;
      return {
        escrow: record.escrow,
        note: record.note,
        creditLine: record.creditLine,
        auction: record.auction,
        agentCard: record.ts.agentCard,
      };
    },
    resolveUsdc: () => {
      usdcPromise ??= readHubConfig(chainContext).then((config) => config.usdc);
      return usdcPromise;
    },
    feedUrl: webEnv.eventsUrl,
    blobToken: webEnv.blobReadWriteToken,
  });
}
