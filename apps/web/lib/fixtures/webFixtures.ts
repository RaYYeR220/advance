import { zeroAddress, type Address, type Hex } from "viem";
import type { AuctionView, Erc8004FeedbackView, EvidenceBundle, LoanView, ScoreResult, TermSheet } from "@advance/sdk";
import type { AgentEvent, EventsSource, HarvestedEvent, LoanActivatedEvent, LoanOpenedEvent, LoanRepaidEvent, OnChainEvent } from "../events";
import { filterEvents, mergeAndPaginate } from "../events";
import type { DataClient } from "../data";

/**
 * The e2e-only fixture data layer: a fully in-memory `DataClient` + `EventsSource` standing in
 * for a live chain and off-chain feed, so `/auctions*` and `/loans/[loanId]` can be exercised
 * end to end without a deployed contract or a real RPC. Wired in by `data.ts`'s
 * `useFixtureDataLayer` gate, which only ever fires under `WEB_E2E_FIXTURES=1`
 * (`playwright.config.ts`'s fixture webServer). Every figure below is fabricated on purpose —
 * this is test fixture data, the same role `e2e/fixtures/fakeUnderwriter.mjs` plays for
 * `/underwrite` — never reachable from a real deployment.
 */

/** A plausible "current tip" for the fixture chain — just past every fixture auction's own
 * `endBlock` — used wherever a page needs a live block number (e.g. the certificate's "latest
 * block" caption) without making a real RPC call. */
export const FIXTURE_BLOCK_NUMBER = 20_000_500n;

const FEES_MANAGER: Address = "0xfeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDC: Address = "0xc9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9";
const REPUTATION_REGISTRY: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

// Loan A — loanId 1, a live auction that hasn't graduated yet.
const AGENT_A: Address = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const CARD_A: Address = "0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
const ESCROW_A: Address = "0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4";
const NOTE_A: Address = "0xa5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
const CREDIT_A: Address = "0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6";
const AUCTION_A: Address = "0xa7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7";

// Loan B — loanId 2, active: graduated, drawing, harvesting, refusing.
const AGENT_B: Address = "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
const CARD_B: Address = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const ESCROW_B: Address = "0xb4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4";
const NOTE_B: Address = "0xb5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5";
const CREDIT_B: Address = "0xb6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6";
const AUCTION_B: Address = "0xb7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7";

// Loan C — loanId 3, repaid in full, nothing ever refused.
const AGENT_C: Address = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
const CARD_C: Address = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
const ESCROW_C: Address = "0xc4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4";
const NOTE_C: Address = "0xc5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5";
const CREDIT_C: Address = "0xc6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6";
const AUCTION_C: Address = "0xc7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7";

const PAYEE_D1: Address = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1";
const PAYEE_D2: Address = "0xd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2";
const PAYEE_D3: Address = "0xd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3";
const PAYEE_E1: Address = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const PAYEE_E2: Address = "0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";

function tx(tag: string, n: number): Hex {
  return `0x${tag.repeat(2)}${n.toString(16).padStart(60, "0")}` as Hex;
}

function termSheet(overrides: Partial<TermSheet>): TermSheet {
  return {
    agentTreasury: zeroAddress,
    agentCard: zeroAddress,
    agentId: 0n,
    feesManager: FEES_MANAGER,
    poolId: `0x${"0".repeat(64)}` as Hex,
    expectedShares: 950_000_000_000_000_000n,
    noteSupply: 0n,
    floorCents: 0,
    minPrincipal: 0n,
    auctionBlocks: 0n,
    drawLimit: 0n,
    drawPeriod: 86_400n,
    gracePeriod: 14n * 86_400n,
    deadline: 9_999_999_999n,
    nonce: 1n,
    memoHash: `0x${"0".repeat(64)}` as Hex,
    ...overrides,
  };
}

function zeroLoan(loanId: bigint): LoanView {
  return {
    loanId,
    status: "None",
    termSheet: termSheet({}),
    escrow: zeroAddress,
    note: zeroAddress,
    creditLine: zeroAddress,
    auction: zeroAddress,
    cap: 0n,
    repaid: 0n,
    principal: 0n,
    drawn: 0n,
    available: 0n,
    lastRevenueAt: 0n,
    openedAt: 0n,
    activatedAt: 0n,
  };
}

function buildLoans(now: number): LoanView[] {
  const loanA: LoanView = {
    loanId: 1n,
    status: "Auction",
    termSheet: termSheet({
      agentTreasury: AGENT_A,
      agentCard: CARD_A,
      agentId: 1n,
      poolId: `0x${"1".repeat(64)}` as Hex,
      noteSupply: 500_000_000_000_000_000_000n, // cap $500
      floorCents: 80,
      minPrincipal: 150_000_000n, // $150
      auctionBlocks: 200n,
      drawLimit: 50_000_000n, // $50/day
      memoHash: `0x${"a".repeat(64)}` as Hex,
    }),
    escrow: ESCROW_A,
    note: NOTE_A,
    creditLine: CREDIT_A,
    auction: AUCTION_A,
    cap: 500_000_000n,
    repaid: 0n,
    principal: 0n,
    drawn: 0n,
    available: 0n,
    lastRevenueAt: 0n,
    openedAt: BigInt(now - 1_200),
    activatedAt: 0n,
  };

  const loanB: LoanView = {
    loanId: 2n,
    status: "Active",
    termSheet: termSheet({
      agentTreasury: AGENT_B,
      agentCard: CARD_B,
      agentId: 2n,
      poolId: `0x${"2".repeat(64)}` as Hex,
      noteSupply: 450_000_000_000_000_000_000n, // cap $450
      floorCents: 85,
      minPrincipal: 150_000_000n,
      auctionBlocks: 150n,
      drawLimit: 40_000_000n, // $40/day
      memoHash: `0x${"b".repeat(64)}` as Hex,
    }),
    escrow: ESCROW_B,
    note: NOTE_B,
    creditLine: CREDIT_B,
    auction: AUCTION_B,
    cap: 450_000_000n,
    repaid: 180_000_000n, // $180
    principal: 300_000_000n, // $300
    drawn: 60_000_000n, // $60
    available: 15_000_000n, // $15 left of today's $40
    lastRevenueAt: BigInt(now - 1_800),
    openedAt: BigInt(now - 90_000),
    activatedAt: BigInt(now - 80_000),
  };

  const loanC: LoanView = {
    loanId: 3n,
    status: "Repaid",
    termSheet: termSheet({
      agentTreasury: AGENT_C,
      agentCard: CARD_C,
      agentId: 3n,
      poolId: `0x${"3".repeat(64)}` as Hex,
      noteSupply: 100_000_000_000_000_000_000n, // cap $100
      floorCents: 90,
      minPrincipal: 80_000_000n,
      auctionBlocks: 100n,
      drawLimit: 20_000_000n, // $20/day
      memoHash: `0x${"c".repeat(64)}` as Hex,
    }),
    escrow: ESCROW_C,
    note: NOTE_C,
    creditLine: CREDIT_C,
    auction: AUCTION_C,
    cap: 100_000_000n,
    repaid: 100_000_000n, // cap reached
    principal: 80_000_000n,
    drawn: 80_000_000n,
    available: 20_000_000n,
    lastRevenueAt: BigInt(now - 100_500),
    openedAt: BigInt(now - 1_000_000),
    activatedAt: BigInt(now - 950_000),
  };

  return [loanA, loanB, loanC];
}

function buildAuctions(): Map<string, AuctionView> {
  const auctionA: AuctionView = {
    endBlock: 20_000_200n,
    blocksLeft: 60n, // 140 of 200 blocks elapsed, not yet graduated
    graduated: false,
    currency: USDC,
    clearingPriceQ96: centsQ96(92),
    requiredCurrencyRaised: 150_000_000n,
    raisedSoFar: 90_000_000n,
  };
  const auctionB: AuctionView = {
    endBlock: 19_998_500n,
    blocksLeft: 0n,
    graduated: true,
    currency: USDC,
    clearingPriceQ96: centsQ96(95),
    requiredCurrencyRaised: 150_000_000n,
    raisedSoFar: 0n, // already swept
  };
  const auctionC: AuctionView = {
    endBlock: 19_500_100n,
    blocksLeft: 0n,
    graduated: true,
    currency: USDC,
    clearingPriceQ96: centsQ96(88),
    requiredCurrencyRaised: 80_000_000n,
    raisedSoFar: 0n,
  };
  return new Map([
    ["1", auctionA],
    ["2", auctionB],
    ["3", auctionC],
  ]);
}

const TICK_SPACING_Q96 = (10_000n * (1n << 96n)) / 10n ** 18n;
function centsQ96(cents: number): bigint {
  return BigInt(cents) * TICK_SPACING_Q96;
}

function harvestEvent(opts: {
  loanId: bigint;
  logIndex: number;
  timestamp: number;
  usdcOut: bigint;
  toNotes: bigint;
  toTreasury: bigint;
}): HarvestedEvent {
  return {
    source: "chain",
    type: "Harvested",
    chainId: 84532,
    blockNumber: BigInt(20_000_000 + opts.logIndex),
    transactionHash: tx("f0", opts.logIndex),
    logIndex: opts.logIndex,
    timestamp: opts.timestamp,
    loanId: opts.loanId,
    wethIn: opts.usdcOut / 2_000n,
    usdcOut: opts.usdcOut,
    toNotes: opts.toNotes,
    toTreasury: opts.toTreasury,
  };
}

function buildOnChainEvents(now: number): OnChainEvent[] {
  const events: OnChainEvent[] = [];

  const bOpenedAt = now - 90_000;
  const bActivatedAt = now - 80_000;
  const opened2: LoanOpenedEvent = {
    source: "chain",
    type: "LoanOpened",
    chainId: 84532,
    blockNumber: 19_998_200n,
    transactionHash: tx("b0", 1),
    logIndex: 0,
    timestamp: bOpenedAt,
    loanId: 2n,
    agentTreasury: AGENT_B,
    escrow: ESCROW_B,
    note: NOTE_B,
    creditLine: CREDIT_B,
    auction: AUCTION_B,
  };
  const activated2: LoanActivatedEvent = {
    source: "chain",
    type: "LoanActivated",
    chainId: 84532,
    blockNumber: 19_998_500n,
    transactionHash: tx("b1", 1),
    logIndex: 0,
    timestamp: bActivatedAt,
    loanId: 2n,
    principal: 300_000_000n,
  };
  events.push(opened2, activated2);
  events.push(
    harvestEvent({ loanId: 2n, logIndex: 1, timestamp: bActivatedAt + 1_000, usdcOut: 70_000_000n, toNotes: 56_000_000n, toTreasury: 14_000_000n }),
    harvestEvent({ loanId: 2n, logIndex: 2, timestamp: bActivatedAt + 40_000, usdcOut: 80_000_000n, toNotes: 64_000_000n, toTreasury: 16_000_000n }),
    harvestEvent({ loanId: 2n, logIndex: 3, timestamp: now - 1_800, usdcOut: 75_000_000n, toNotes: 60_000_000n, toTreasury: 15_000_000n }),
  );

  const cOpenedAt = now - 1_000_000;
  const cActivatedAt = now - 950_000;
  const cRepaidAt = now - 100_000;
  const opened3: LoanOpenedEvent = {
    source: "chain",
    type: "LoanOpened",
    chainId: 84532,
    blockNumber: 19_500_000n,
    transactionHash: tx("c0", 1),
    logIndex: 0,
    timestamp: cOpenedAt,
    loanId: 3n,
    agentTreasury: AGENT_C,
    escrow: ESCROW_C,
    note: NOTE_C,
    creditLine: CREDIT_C,
    auction: AUCTION_C,
  };
  const activated3: LoanActivatedEvent = {
    source: "chain",
    type: "LoanActivated",
    chainId: 84532,
    blockNumber: 19_500_100n,
    transactionHash: tx("c1", 1),
    logIndex: 0,
    timestamp: cActivatedAt,
    loanId: 3n,
    principal: 80_000_000n,
  };
  const repaid3: LoanRepaidEvent = {
    source: "chain",
    type: "LoanRepaid",
    chainId: 84532,
    blockNumber: 19_600_000n,
    transactionHash: tx("c2", 1),
    logIndex: 0,
    timestamp: cRepaidAt,
    loanId: 3n,
    totalRepaid: 100_000_000n,
  };
  events.push(opened3, activated3, repaid3);
  events.push(
    harvestEvent({ loanId: 3n, logIndex: 4, timestamp: cActivatedAt + 1_000, usdcOut: 75_000_000n, toNotes: 60_000_000n, toTreasury: 15_000_000n }),
    harvestEvent({ loanId: 3n, logIndex: 5, timestamp: cRepaidAt - 500, usdcOut: 50_000_000n, toNotes: 40_000_000n, toTreasury: 10_000_000n }),
  );

  return events;
}

function refusal(opts: { id: string; loanId: bigint; timestamp: number; layer: string; reason: string; payTo?: Address; amount?: string; txHash?: Hex }): AgentEvent {
  return {
    source: "agent",
    id: opts.id,
    type: "refusal",
    agent: undefined,
    loanId: opts.loanId.toString(),
    timestamp: opts.timestamp,
    data: { layer: opts.layer, reason: opts.reason, payTo: opts.payTo, amount: opts.amount },
    txHash: opts.txHash,
  };
}

function receipt(opts: { id: string; loanId: bigint; timestamp: number; payee: Address; amount: string; txHash: Hex }): AgentEvent {
  return {
    source: "agent",
    id: opts.id,
    type: "receipt",
    loanId: opts.loanId.toString(),
    timestamp: opts.timestamp,
    data: { payee: opts.payee, amount: opts.amount },
    txHash: opts.txHash,
  };
}

function buildOffChainEvents(now: number): AgentEvent[] {
  return [
    refusal({
      id: "refusal-gateway-1",
      loanId: 2n,
      timestamp: now - 7_200,
      layer: "gateway",
      reason: "Payee 0xd1d1…d1d1 is not on the card's allowlist — the gateway never forwarded the request to be signed.",
      payTo: PAYEE_D1,
      amount: "120.00",
    }),
    refusal({
      id: "refusal-card-1271-1",
      loanId: 2n,
      timestamp: now - 6_000,
      layer: "card-1271",
      reason: "The agent card's own on-chain signature check (ERC-1271) refused to validate a transfer to a payee off its allowlist.",
      payTo: PAYEE_D2,
      amount: "45.50",
      txHash: tx("11", 6),
    }),
    refusal({
      id: "refusal-credit-line-1",
      loanId: 2n,
      timestamp: now - 5_400,
      layer: "credit-line",
      reason: "CreditLine reverted: the requested draw of $60.00 exceeds the $40.00 daily limit.",
      amount: "60.00",
      txHash: tx("22", 5),
    }),
    refusal({
      id: "refusal-dynamic-1",
      loanId: 2n,
      timestamp: now - 4_800,
      layer: "dynamic",
      reason: "The card's signing policy blocked a payment above its per-transaction cap, independent of the on-chain allowlist.",
      payTo: PAYEE_D3,
      amount: "500.00",
    }),
    receipt({ id: "receipt-1", loanId: 2n, timestamp: now - 3_000, payee: PAYEE_E1, amount: "2.40", txHash: tx("33", 1) }),
    receipt({ id: "receipt-2", loanId: 2n, timestamp: now - 2_400, payee: PAYEE_E2, amount: "0.75", txHash: tx("33", 2) }),
    receipt({ id: "receipt-3", loanId: 2n, timestamp: now - 1_200, payee: PAYEE_E1, amount: "5.00", txHash: tx("33", 3) }),
  ];
}

// Loan C (agentId 3n) repaid in full — the one fixture agent with real posted feedback, mirroring
// the protocol's repaid path (`+100 / "advance" / "repaid"`) so the e2e suite can assert the
// feedback section renders a real record, not just its honest empty state.
const FEEDBACK_BY_AGENT_ID = new Map<bigint, Erc8004FeedbackView>([
  [
    3n,
    {
      agentId: 3n,
      index: 1n,
      value: 100n,
      valueDecimals: 0,
      tag1: "advance",
      tag2: "repaid",
      isRevoked: false,
      registry: REPUTATION_REGISTRY,
    },
  ],
]);

const FIXTURE_SCORE: ScoreResult = {
  kind: "deny",
  token: zeroAddress,
  reasons: ["not_bankr_doppler"],
  evidenceHash: `0x${"0".repeat(64)}` as Hex,
  evidence: {} as EvidenceBundle,
} as unknown as ScoreResult;

const FIXTURE_EVIDENCE = {} as EvidenceBundle;

export function buildFixtureDataClient(): DataClient {
  const now = Math.floor(Date.now() / 1000);
  const loans = buildLoans(now);
  const auctions = buildAuctions();

  return {
    async loans(filter) {
      return loans.filter((loan) => {
        if (filter?.status !== undefined && loan.status !== filter.status) return false;
        if (filter?.agent !== undefined && loan.termSheet.agentTreasury.toLowerCase() !== filter.agent.toLowerCase()) return false;
        return true;
      });
    },
    async loan(loanId) {
      return loans.find((l) => l.loanId === loanId) ?? zeroLoan(loanId);
    },
    async auction(loanId) {
      const auction = auctions.get(loanId.toString());
      if (!auction) throw new Error(`fixture: no auction recorded for loan ${loanId}`);
      return auction;
    },
    async score() {
      return FIXTURE_SCORE;
    },
    async evidence() {
      return FIXTURE_EVIDENCE;
    },
    async feedback(agentId) {
      return FEEDBACK_BY_AGENT_ID.get(agentId) ?? null;
    },
  };
}

export function buildFixtureEventsSource(): EventsSource {
  const now = Math.floor(Date.now() / 1000);
  const onChain = buildOnChainEvents(now);
  const offChain = buildOffChainEvents(now);

  return {
    async list(query = {}) {
      const loanId = query.loanId === undefined ? undefined : query.loanId.toString();
      const filteredOnChain = onChain.filter((event) => {
        if (loanId !== undefined && (event.loanId === undefined || event.loanId.toString() !== loanId)) return false;
        if (query.types && !query.types.includes(event.type)) return false;
        if (query.sinceSeconds !== undefined && event.timestamp < query.sinceSeconds) return false;
        return true;
      });
      const filteredOffChain = filterEvents(offChain, { loanId: query.loanId, types: query.types, sinceSeconds: query.sinceSeconds });
      return mergeAndPaginate(filteredOnChain, filteredOffChain, { limit: query.limit, cursor: query.cursor });
    },
  };
}
