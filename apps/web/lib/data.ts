import type { Address } from "viem";
import { zeroAddress } from "viem";
import {
  AdvanceClient,
  q96ToCents,
  TICK_SPACING_Q96,
  type AuctionView,
  type EvidenceBundle,
  type LoanStatus,
  type LoanView,
  type ScoreResult,
} from "@advance/sdk";
import type { AuctionListItem } from "./auctions";
import { addressPrefix } from "./format";
import { getPublicClient, loadWebEnv, type SupportedChainId, type WebEnv } from "./env";
import { createLiveEventsSource, type EventsPage, type EventsSource, type HarvestedEvent } from "./events";
import { buildFixtureDataClient, buildFixtureEventsSource, FIXTURE_BLOCK_NUMBER } from "./fixtures/webFixtures";
import { createTtlCache, type TtlCache } from "./ttlCache";
import type { LandingData } from "./landing-data";

/**
 * Typed server-side reads over `@advance/sdk` (chain state) and the underwriter API (score,
 * evidence). Every exported function is a plain async call, not a class, and every one takes
 * an optional `DataDeps` so a test can inject a fake client/events source instead of a live
 * chain — the plan's whole point: no contracts are deployed yet, so correctness here has to
 * come from fixtures, not a fork.
 *
 * Caching: a single in-process TTL cache (`ttlCache.ts`) shared by every function below.
 * Every cached value here is public and identical for every visitor — loan/auction/score/
 * economy/landing reads — never a signed-in lender's own portfolio, which belongs in its own,
 * uncached, per-request read (out of this task's scope).
 */

// ---------------------------------------------------------------------------------------------
// Client / dependency wiring
// ---------------------------------------------------------------------------------------------

/** The subset of `AdvanceClient` this module reads from — small enough that tests fake it
 * directly (`{ loans, loan, auction, score, evidence }`) rather than constructing a real viem
 * `PublicClient`. A real `AdvanceClient` instance satisfies this as-is. */
export type DataClient = Pick<AdvanceClient, "loans" | "loan" | "auction" | "score" | "evidence">;

export interface DataDeps {
  client?: DataClient;
  events?: EventsSource;
  webEnv?: WebEnv;
  /** Unix seconds. Defaults to the real wall clock. */
  now?: () => number;
  getBlockNumber?: () => Promise<bigint>;
}

// A real deployment has exactly one `WebEnv` for the process's lifetime, so these singletons
// are built once from whichever `webEnv` first constructs them and reused after — tests never
// hit this path (they pass `client`/`events` directly) or call `resetDataLayerForTests`.
let defaultClient: DataClient | undefined;
let defaultEvents: EventsSource | undefined;

/**
 * e2e-only escape hatch: when set, every page reads a fully in-memory fixture instead of a
 * real chain/underwriter, so `/auctions*` and `/loans/[loanId]` can be exercised end to end
 * with no live RPC. Never set outside `playwright.config.ts`'s fixture webServer — a normal
 * `deps.client`/`deps.events` injection (as every unit test in this repo already uses) always
 * takes priority over this, and production never sets the env var at all.
 */
function useFixtureDataLayer(): boolean {
  return process.env.WEB_E2E_FIXTURES === "1";
}

function resolveWebEnv(deps?: DataDeps): WebEnv {
  return deps?.webEnv ?? loadWebEnv();
}

function resolveClient(deps?: DataDeps): DataClient {
  if (deps?.client) return deps.client;
  const webEnv = resolveWebEnv(deps);
  if (useFixtureDataLayer()) {
    defaultClient ??= buildFixtureDataClient();
    return defaultClient;
  }
  defaultClient ??= new AdvanceClient({
    chainId: webEnv.chainId,
    apiUrl: webEnv.underwriterApiUrl,
    publicClient: getPublicClient(webEnv),
    hub: webEnv.hub,
  });
  return defaultClient;
}

function resolveEvents(deps?: DataDeps): EventsSource {
  if (deps?.events) return deps.events;
  const webEnv = resolveWebEnv(deps);
  if (useFixtureDataLayer()) {
    defaultEvents ??= buildFixtureEventsSource();
    return defaultEvents;
  }
  defaultEvents ??= createLiveEventsSource(webEnv);
  return defaultEvents;
}

function resolveNowSeconds(deps?: DataDeps): number {
  return deps?.now ? deps.now() : Math.floor(Date.now() / 1000);
}

function resolveBlockNumber(deps?: DataDeps): Promise<bigint> {
  if (deps?.getBlockNumber) return deps.getBlockNumber();
  if (useFixtureDataLayer()) return Promise.resolve(FIXTURE_BLOCK_NUMBER);
  const webEnv = resolveWebEnv(deps);
  return getPublicClient(webEnv).getBlockNumber();
}

/** The chain's current block number — the same read `getLandingData`/`getEconomy` use for
 * their own "as of" figures, exposed directly for pages (e.g. the loan certificate's "latest
 * block" caption) that need it without a full loans/economy read. */
export function getLatestBlock(deps?: DataDeps): Promise<bigint> {
  return resolveBlockNumber(deps);
}

/** Test-only: drops the process-wide default client/events singletons, and the shared cache,
 * so a test that doesn't inject its own deps doesn't see state left over from another test. */
export function resetDataLayerForTests(): void {
  defaultClient = undefined;
  defaultEvents = undefined;
  cache.clear();
}

const cache: TtlCache = createTtlCache();

const LOANS_TTL_MS = 30_000;
const LOAN_TTL_MS = 20_000;
const AUCTION_TTL_MS = 10_000;
const AUCTIONS_TTL_MS = 10_000;
const SCORE_TTL_MS = 60_000;
const EVIDENCE_TTL_MS = 5 * 60_000;
const ECONOMY_TTL_MS = 30_000;
const LANDING_TTL_MS = 30_000;
const LOAN_ACTIVITY_TTL_MS = 15_000;
const LOAN_ACTIVITY_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// Loans / auctions / score
// ---------------------------------------------------------------------------------------------

export interface LoansFilter {
  status?: LoanStatus;
  agent?: Address;
}

/** Every loan the hub has opened, optionally filtered by status and/or borrower. */
export async function getLoans(filter?: LoansFilter, deps?: DataDeps): Promise<LoanView[]> {
  const client = resolveClient(deps);
  const key = `loans:${filter?.status ?? ""}:${filter?.agent?.toLowerCase() ?? ""}`;
  return cache.get(key, LOANS_TTL_MS, () => client.loans(filter));
}

/** A single loan's on-chain state, or `null` if `loanId` never opened a loan (status `None`)
 * — never a zeroed placeholder `LoanView`, so a page can render an honest "no such loan"
 * instead of a certificate full of zeros. */
export async function getLoan(loanId: bigint, deps?: DataDeps): Promise<LoanView | null> {
  const client = resolveClient(deps);
  const loan = await cache.get(`loan:${loanId}`, LOAN_TTL_MS, () => client.loan(loanId));
  return loan.status === "None" ? null : loan;
}

/** A loan's CCA auction, or `null` when the loan itself doesn't exist (an auction can't be
 * read off a loan id whose contracts were never deployed). */
export async function getAuction(loanId: bigint, deps?: DataDeps): Promise<AuctionView | null> {
  const loan = await getLoan(loanId, deps);
  if (!loan) return null;
  const client = resolveClient(deps);
  return cache.get(`auction:${loanId}`, AUCTION_TTL_MS, () => client.auction(loanId));
}

/** Every loan the hub has opened, paired with its own CCA auction — `/auctions`' whole read.
 * Every loan carries its auction's address from the moment it opens (see `LoanView.auction`),
 * so this is one `getLoans` plus one `auction()` read per loan, no separate "is this loan an
 * auction" filter. */
export async function getAuctions(deps?: DataDeps): Promise<AuctionListItem[]> {
  return cache.get("auctions", AUCTIONS_TTL_MS, async () => {
    const loans = await getLoans(undefined, deps);
    const client = resolveClient(deps);
    const auctions = await Promise.all(loans.map((loan) => client.auction(loan.loanId)));
    return loans.map((loan, i) => ({ loan, auction: auctions[i]! }));
  });
}

/** A single loan's own activity feed (on-chain draws/harvests/distributions/claims plus any
 * off-chain refusals/receipts), newest first — the one read `/loans/[loanId]` builds its
 * timelines, meters and refusal exhibits from. */
export async function getLoanActivity(loanId: bigint, deps?: DataDeps): Promise<EventsPage> {
  const events = resolveEvents(deps);
  return cache.get(`activity:${loanId}`, LOAN_ACTIVITY_TTL_MS, () => events.list({ loanId, limit: LOAN_ACTIVITY_LIMIT }));
}

const RECENT_EVENTS_TTL_MS = 10_000;

/** The hub's recent loan-lifecycle events plus any configured off-chain feed, unscoped to a
 * single loan — `/economy`'s live ticker. Mirrors `/api/events`'s own no-params default (see
 * `events.ts`'s module doc for why an unscoped read can't include per-loan contract events
 * like `Drawn`/`Harvested`/`Claimed`, only hub-level lifecycle ones can). */
export async function getRecentEvents(limit = 20, deps?: DataDeps): Promise<EventsPage> {
  const events = resolveEvents(deps);
  return cache.get(`events:recent:${limit}`, RECENT_EVENTS_TTL_MS, () => events.list({ limit }));
}

/** A token's free eligibility score from the underwriter (`GET /v1/score/:token`). */
export async function getScore(token: Address, deps?: DataDeps): Promise<ScoreResult> {
  const client = resolveClient(deps);
  return cache.get(`score:${token.toLowerCase()}`, SCORE_TTL_MS, () => client.score(token));
}

/** The full evidence bundle a loan's term sheet was underwritten from
 * (`termSheet.memoHash` is exactly the hash `GET /v1/evidence/:hash` is keyed by — see
 * `packages/core`'s `engine.ts`, which sets `memoHash: evidenceHash(finalEvidence)`).
 * `undefined` if the underwriter no longer has that bundle stored. */
export async function getLoanEvidence(loan: LoanView, deps?: DataDeps): Promise<EvidenceBundle | undefined> {
  const client = resolveClient(deps);
  try {
    return await cache.get(`evidence:${loan.termSheet.memoHash}`, EVIDENCE_TTL_MS, () => client.evidence(loan.termSheet.memoHash));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------------------------

const ECONOMY_LOOKBACK_DAYS = 7;
const ECONOMY_ACTIVITY_LIMIT = 200;

export interface EconomyAgent {
  agentTreasury: Address;
  agentCard: Address;
  agentId: bigint;
  loanId: bigint;
  status: LoanStatus;
  cap: bigint;
  repaid: bigint;
  drawn: bigint;
  available: bigint;
  /** Seconds left in the loan's grace period before it becomes eligible for
   * `markDefault` due to silence — `null` when the loan isn't `Active` (grace-period
   * tracking doesn't apply to any other status). Clamped at `0`, never negative. */
  runwaySeconds: bigint | null;
  /** The loan's own `termSheet.gracePeriod` — the denominator `runwaySeconds` counts down
   * from, so a caller can render a meter (used vs. total) rather than just a countdown. */
  gracePeriodSeconds: bigint;
  /** Real USDC swept to this loan's escrow within the last `lookbackDays`, summed from
   * on-chain `Harvested` events (`usdcOut`) — `0n` when there truly were none, never
   * omitted or invented. */
  revenue7dUsdc: bigint;
  lastEventAt: number | null;
  lastEventType: string | null;
}

export interface EconomyView {
  chainId: SupportedChainId;
  asOfBlock: bigint;
  lookbackDays: number;
  agents: EconomyAgent[];
}

/** One row per agent treasury — the loan with the latest `openedAt` wins when an agent has
 * more than one (e.g. a `Failed`/`Defaulted` loan followed by a fresh one). */
function latestLoanPerAgent(loans: readonly LoanView[]): LoanView[] {
  const byAgent = new Map<string, LoanView>();
  for (const loan of loans) {
    const key = loan.termSheet.agentTreasury.toLowerCase();
    const existing = byAgent.get(key);
    if (!existing || loan.openedAt >= existing.openedAt) byAgent.set(key, loan);
  }
  return [...byAgent.values()];
}

function clampNonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function isHarvested(event: { source: string; type: string }): event is HarvestedEvent {
  return event.source === "chain" && event.type === "Harvested";
}

async function economyAgentFor(loan: LoanView, events: EventsSource, nowSeconds: number): Promise<EconomyAgent> {
  const lookbackSeconds = ECONOMY_LOOKBACK_DAYS * 24 * 60 * 60;
  const page = await events.list({ loanId: loan.loanId, limit: ECONOMY_ACTIVITY_LIMIT });

  const revenue7dUsdc = page.events
    .filter(isHarvested)
    .filter((e) => e.timestamp >= nowSeconds - lookbackSeconds)
    .reduce((sum, e) => sum + e.usdcOut, 0n);

  const last = page.events[0];

  const runwaySeconds =
    loan.status === "Active" ? clampNonNegative(loan.termSheet.gracePeriod - (BigInt(nowSeconds) - loan.lastRevenueAt)) : null;

  return {
    agentTreasury: loan.termSheet.agentTreasury,
    agentCard: loan.termSheet.agentCard,
    agentId: loan.termSheet.agentId,
    loanId: loan.loanId,
    status: loan.status,
    cap: loan.cap,
    repaid: loan.repaid,
    drawn: loan.drawn,
    available: loan.available,
    runwaySeconds,
    gracePeriodSeconds: loan.termSheet.gracePeriod,
    revenue7dUsdc,
    lastEventAt: last?.timestamp ?? null,
    lastEventType: last?.type ?? null,
  };
}

/** Every agent with a loan, one row each, with a real (event-derived) 7-day revenue figure,
 * on-chain draw/repay state, and a grace-period-derived runway. Empty `agents` — not
 * fabricated rows — when the hub has never opened a loan. */
export async function getEconomy(deps?: DataDeps): Promise<EconomyView> {
  const webEnv = resolveWebEnv(deps);
  const nowSeconds = resolveNowSeconds(deps);

  return cache.get("economy", ECONOMY_TTL_MS, async () => {
    const [loans, asOfBlock] = await Promise.all([getLoans(undefined, deps), resolveBlockNumber(deps)]);
    const events = resolveEvents(deps);
    const agents = await Promise.all(latestLoanPerAgent(loans).map((loan) => economyAgentFor(loan, events, nowSeconds)));

    return { chainId: webEnv.chainId, asOfBlock, lookbackDays: ECONOMY_LOOKBACK_DAYS, agents };
  });
}

// ---------------------------------------------------------------------------------------------
// Landing page data — same `LandingData` shape as the Task 1 design fixture
// ---------------------------------------------------------------------------------------------

const NOTE_USD_DECIMALS = 1_000_000; // USDC-wei -> whole USD
const HARVEST_HISTORY_LIMIT = 60;

function toUsd(usdcWei: bigint): number {
  return Number(usdcWei) / NOTE_USD_DECIMALS;
}

function monthYear(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** An honest, all-zero `LandingData` for "the hub has never opened a loan yet" — every number
 * in it is real (there is in fact nothing to show), not a placeholder standing in for missing
 * data. Components decide how to phrase that state; this just refuses to invent a fake agent. */
export function emptyLandingData(chainId: SupportedChainId, nowSeconds: number, asOfBlock: bigint): LandingData {
  return {
    chainId,
    issue: { number: "00", date: monthYear(nowSeconds) },
    hero: {
      agent: zeroAddress,
      loansRepaid: 0,
      defaults: 0,
      weeklyFeesUsd: 0,
      note: {
        agentLabel: addressPrefix(zeroAddress),
        series: addressPrefix(zeroAddress),
        notesOutstanding: 0,
        repaidPerNote: 1,
        clearingPriceCents: 0,
        capMultiple: 0,
        borrowedUsd: 0,
        repaidUsd: 0,
        capUsd: 0,
        sweeps: [],
        latestBlock: Number(asOfBlock),
      },
    },
    lifecycle: { score: 0, floorCents: 0, clearingPriceCents: 0, dailyLimitUsd: 0, blockedDrawUsd: 0 },
    refusal: {
      block: Number(asOfBlock),
      agent: zeroAddress,
      payee: zeroAddress,
      promptedUsdc: 0,
      receipt: { tx: `0x${"0".repeat(64)}`, creditLine: zeroAddress, drawUsdc: 0, dailyLimitUsdc: 0, drawnTodayUsdc: 0, error: "", gasUsed: 0 },
      tally: { refusals: 0, unauthorizedTransfers: 0, revertedDraws: 0, refusedPayments: 0, fundedAgents: 0 },
    },
    audiences: {
      token: zeroAddress,
      quote: { score: 0, maxUsd: 0, dailyLimitUsd: 0, notes: 0 },
      memo: { largestPoolSharePct: 0, formulaLimitUsd: 0 },
      auction: { startBlock: Number(asOfBlock), blocks: 0, floorCents: 0, steps: [], bid: { maxPriceCents: 0, atBlock: 0, budgetUsdc: 0, filledNotes: 0, claimableUsd: 0 } },
    },
    economy: { fundedAgents: 0, repaidUsd: 0, refusals: 0, weeklyRepaidUsd: [], block: Number(asOfBlock) },
    builtOn: BUILT_ON,
  };
}

/** Static protocol/rail descriptions — documentation copy, not a claimed live number, so it's
 * fine to keep fixed (matches the Task 1 fixture verbatim). */
const BUILT_ON: LandingData["builtOn"] = {
  contracts: [
    { name: "AdvanceHub", role: "term sheets, loans, defaults" },
    { name: "RevenueEscrow", role: "holds fee rights, runs sweeps" },
    { name: "RevenueNote", role: "one token per $1 of repayment" },
    { name: "CreditLine", role: "daily draw limit, card only" },
  ],
  rails: [
    { name: "Bankr", role: "Token launches and the trading fees that back every loan.", detail: "Also the LLM gateway agents pay from their cards." },
    { name: "Uniswap", role: "Continuous clearing auctions price each note.", detail: "Pools convert swept fees to USDC." },
    { name: "Dynamic", role: "Server wallets for each agent's treasury and card.", detail: "Signing policies refuse payees off the allowlist." },
    { name: "Base", role: "Where every loan, draw, sweep and refusal settles.", detail: "Chain 8453." },
    { name: "ERC-8004", role: "Agent identity and reputation registries.", detail: "Repayments and defaults are posted here." },
  ],
};

/** Picks the loan the landing page's certificate/exhibits are built from: the most recently
 * opened `Active` loan, or (nothing active) the most recently opened loan of any status — so
 * there is always something real to show as long as at least one loan has ever opened. */
function pickHeroLoan(loans: readonly LoanView[]): LoanView | undefined {
  const active = loans.filter((l) => l.status === "Active");
  const pool = active.length > 0 ? active : loans;
  return pool.reduce<LoanView | undefined>((latest, loan) => (!latest || loan.openedAt > latest.openedAt ? loan : latest), undefined);
}

/**
 * Assembles the landing page's `LandingData` from live chain/event/evidence reads, replacing
 * the Task 1 design fixture with the same shape so the existing components need no changes.
 * Two fields are real-but-relabeled rather than fabricated, both documented at their call
 * site below: `lifecycle.score`/`audiences.quote.score` come from the loan's own evidence
 * bundle (`formula.quality.haircutBps`, converted from bps to a 0-100 scale — that field
 * already *is* the underwriting engine's own quality/trust multiplier); `audiences.auction.
 * steps` is a real two-point read (the term sheet's floor at block 0, and the auction's
 * current observed clearing price at its current elapsed block) rather than the full
 * per-block schedule, which isn't exposed by any read this SDK has.
 */
export async function getLandingData(deps?: DataDeps): Promise<LandingData> {
  const webEnv = resolveWebEnv(deps);
  const nowSeconds = resolveNowSeconds(deps);

  return cache.get("landing", LANDING_TTL_MS, async () => {
    const [loans, asOfBlock] = await Promise.all([getLoans(undefined, deps), resolveBlockNumber(deps)]);

    const heroLoan = pickHeroLoan(loans);
    if (!heroLoan) return emptyLandingData(webEnv.chainId, nowSeconds, asOfBlock);

    const events = resolveEvents(deps);
    const [auction, evidence, activity, economy] = await Promise.all([
      getAuction(heroLoan.loanId, deps),
      getLoanEvidence(heroLoan, deps),
      events.list({ loanId: heroLoan.loanId, types: ["Harvested"], limit: HARVEST_HISTORY_LIMIT }),
      getEconomy(deps),
    ]);

    const agentLoans = loans.filter((l) => l.termSheet.agentTreasury.toLowerCase() === heroLoan.termSheet.agentTreasury.toLowerCase());
    const loansRepaid = agentLoans.filter((l) => l.status === "Repaid").length;
    const defaults = agentLoans.filter((l) => l.status === "Defaulted").length;

    const clearingPriceCents = auction ? q96ToCents(roundToTick(auction.clearingPriceQ96)) : heroLoan.termSheet.floorCents;
    // Chronological (oldest first), matching the fixture's sweep-history ordering.
    const sweeps = [...activity.events].filter(isHarvested).reverse().map((e) => toUsd(e.usdcOut));

    const heroEconomy = economy.agents.find((a) => a.loanId === heroLoan.loanId);
    const weeklyFeesUsd = heroEconomy ? toUsd(heroEconomy.revenue7dUsdc) : 0;

    // haircutBps (0..10000) is the underwriting engine's own multiplicative quality factor —
    // converting bps to a 0-100 scale is a unit conversion of a real, already-computed engine
    // output, not an invented heuristic. `undefined` evidence (bundle no longer stored) reads
    // as 0 rather than a guessed number.
    const score = evidence ? Math.round(evidence.formula.quality.haircutBps / 100) : 0;
    const largestPoolSharePct = evidence ? Math.round(evidence.formula.quality.top5ConcentrationRatio * 100) : 0;
    const formulaLimitUsd = evidence ? toUsd(evidence.formula.computedTerms.minPrincipal) : toUsd(heroLoan.termSheet.minPrincipal);

    const dailyLimitUsd = toUsd(heroLoan.termSheet.drawLimit);
    const capUsd = toUsd(heroLoan.cap);
    const borrowedUsd = toUsd(heroLoan.principal);
    const repaidUsd = toUsd(heroLoan.repaid);

    const auctionStartBlock = auction ? Number(auction.endBlock - heroLoan.termSheet.auctionBlocks) : Number(asOfBlock);
    const auctionElapsedBlocks = auction ? Number(heroLoan.termSheet.auctionBlocks - auction.blocksLeft) : 0;

    return {
      chainId: webEnv.chainId,
      issue: { number: String(loans.length).padStart(2, "0"), date: monthYear(nowSeconds) },
      hero: {
        agent: heroLoan.termSheet.agentTreasury,
        loansRepaid,
        defaults,
        weeklyFeesUsd,
        note: {
          agentLabel: addressPrefix(heroLoan.termSheet.agentTreasury),
          series: addressPrefix(heroLoan.termSheet.agentTreasury),
          notesOutstanding: capUsd, // 1 note == $1 of cap, by construction (noteSupply/1e12 == cap in USDC-wei)
          repaidPerNote: 1,
          clearingPriceCents,
          capMultiple: borrowedUsd > 0 ? capUsd / borrowedUsd : 0,
          borrowedUsd,
          repaidUsd,
          capUsd,
          sweeps,
          latestBlock: Number(asOfBlock),
        },
      },
      lifecycle: {
        score,
        floorCents: heroLoan.termSheet.floorCents,
        clearingPriceCents,
        dailyLimitUsd,
        blockedDrawUsd: dailyLimitUsd, // the smallest real draw the credit line would refuse today
      },
      // No refusal exhibit is built here: refusals are off-chain agent events (see events.ts's
      // module doc) — wiring the landing page's refusal spread to the real feed is Task 3's
      // job, once the page itself calls `EventsSource.list({ types: ["refusal"] })`.
      refusal: emptyLandingData(webEnv.chainId, nowSeconds, asOfBlock).refusal,
      audiences: {
        token: evidence?.token ?? zeroAddress,
        quote: { score, maxUsd: capUsd, dailyLimitUsd, notes: capUsd },
        memo: { largestPoolSharePct, formulaLimitUsd },
        auction: {
          startBlock: auctionStartBlock,
          blocks: Number(heroLoan.termSheet.auctionBlocks),
          floorCents: heroLoan.termSheet.floorCents,
          steps: auction
            ? [
                { fromBlock: 0, priceCents: heroLoan.termSheet.floorCents },
                { fromBlock: auctionElapsedBlocks, priceCents: clearingPriceCents },
              ]
            : [],
          bid: { maxPriceCents: clearingPriceCents, atBlock: auctionElapsedBlocks, budgetUsdc: 0, filledNotes: 0, claimableUsd: 0 },
        },
      },
      economy: {
        fundedAgents: economy.agents.length,
        repaidUsd: loans.reduce((sum, l) => sum + toUsd(l.repaid), 0),
        refusals: 0, // off-chain feed, see the `refusal` comment above
        weeklyRepaidUsd: [],
        block: Number(asOfBlock),
      },
      builtOn: BUILT_ON,
    };
  });
}

/** `AuctionView.clearingPriceQ96` isn't guaranteed to land exactly on a tick boundary between
 * checkpoints; rounds down to the nearest tick so `q96ToCents` (which requires an exact
 * multiple) never throws on a live read. */
function roundToTick(priceQ96: bigint): bigint {
  return (priceQ96 / TICK_SPACING_Q96) * TICK_SPACING_Q96;
}

// ---------------------------------------------------------------------------------------------
// Safe landing read — never lets a missing/bad deployment config crash the page
// ---------------------------------------------------------------------------------------------

/** Mirrors `loadWebEnv`'s own chain-id default, without requiring `ADVANCE_HUB`/
 * `UNDERWRITER_API_URL` to be set — used only once `resolveWebEnv` has already thrown, so
 * there's still a sensible chain to attribute the empty state to. */
function fallbackChainId(): SupportedChainId {
  return Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532") === 8453 ? 8453 : 84532;
}

function safeChainId(deps?: DataDeps): SupportedChainId {
  try {
    return resolveWebEnv(deps).chainId;
  } catch {
    return fallbackChainId();
  }
}

/**
 * `getLandingData`, but never throws: before any contract is deployed (`ADVANCE_HUB` unset)
 * or while the chain/underwriter is briefly unreachable, this falls back to the same honest,
 * all-zero shape `getLandingData` itself already returns for "no loans yet" — the landing
 * page always has something real (if empty) to render, never a crash. A best-effort block
 * number is still attempted (never a live call in a test that injects `getBlockNumber`);
 * `0n` only if that also fails.
 */
export async function getLandingDataSafe(deps?: DataDeps): Promise<LandingData> {
  try {
    return await getLandingData(deps);
  } catch {
    const chainId = safeChainId(deps);
    const nowSeconds = resolveNowSeconds(deps);
    let asOfBlock: bigint;
    try {
      // `resolveBlockNumber` isn't itself `async` — a bad config throws synchronously here,
      // not as a rejection, so `.catch(...)` alone wouldn't see it. `await` inside `try` covers
      // both.
      asOfBlock = await resolveBlockNumber(deps);
    } catch {
      asOfBlock = 0n;
    }
    return emptyLandingData(chainId, nowSeconds, asOfBlock);
  }
}

// ---------------------------------------------------------------------------------------------
// Underwriter API base — for linking to `/v1/evidence/:hash` from a score result
// ---------------------------------------------------------------------------------------------

/** The underwriter API's base URL (no trailing slash) — used to link straight to
 * `/v1/evidence/:hash` for a score's evidence bundle, the same host `getScore` itself reads. */
export function underwriterApiBase(deps?: DataDeps): string {
  return resolveWebEnv(deps).underwriterApiUrl;
}
