#!/usr/bin/env node
/**
 * Drives the whole Base Sepolia demo economy end to end: provisions three agents, signs and
 * opens a real loan for each, bids and settles each auction, draws and spends through the card
 * gateway, generates real Doppler-pool swap volume, harvests Agent A to Repaid, leaves Agent B
 * mid-loan, walks Agent C past its grace period into a real default, and records three refused
 * payment attempts (a gateway precheck refusal, an on-chain ERC-1271 refusal, and an on-chain
 * over-limit draw revert).
 *
 * Idempotent and resumable: every step is recorded in `.data/seed-checkpoint.json` and skipped on
 * a later run. Two kinds of step exit the whole process early instead of failing - waiting for an
 * auction's end block and waiting out Agent C's grace period - so the script is meant to be
 * re-invoked every few minutes rather than left running unattended for the whole demo.
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  advanceHubAbi,
  ccaAbi,
  creditLineAbi,
  feesManagerAbi,
  permit2Abi,
  revenueEscrowAbi,
  revenueNoteAbi,
  signTermSheet,
  termSheetDigest,
  type TermSheet,
} from "@advance/core";
import {
  claim,
  createCardFetch,
  drawCredit,
  harvest,
  markDefault,
  moveBeneficiary,
  openLoan,
  predictEscrow,
  settleAuction,
  cardSigner,
} from "@advance/agent-kit";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { buildActionContext, loadDemoEnv, type DemoEnv } from "../demo/setup.js";
import { withNonceRetry } from "../chain/localKeys.js";
import { Checkpoint } from "../demo/checkpoint.js";
import { provisionAgent, rosterFromJson, rosterToJson, type ProvisionAgentParams } from "./provision-agent.js";
import type { AgentRosterEntry } from "../roster.js";
import { loadConfig } from "../config.js";
import { createServiceApp } from "../services/x402-llm.js";
import { startServer } from "./serve-x402-llm.js";
import { tickAgent } from "./run-agents.js";

const TICK_Q96 = (10_000n << 96n) / 10n ** 18n;
const EXPECTED_SHARES = 950_000_000_000_000_000n; // 0.95e18, matches buildDopplerLaunchPlan's treasury share
const MAX_HARVEST_ROUNDS = 26;
const BLOCK_TIME_SECONDS = 2n;

interface AgentSpec {
  name: string;
  persona: string;
  tokenName: string;
  tokenSymbol: string;
  noteSupplyUsd1e18: bigint; // repayment cap, note-wei (cap USDC-wei = this / 1e12)
  floorCents: number;
  minPrincipal: bigint;
  bidAmount: bigint;
  bidCents: number;
  auctionBlocks: bigint;
  drawLimit: bigint;
  drawPeriod: bigint;
  gracePeriod: bigint;
}

const AGENT_SPECS: AgentSpec[] = [
  {
    name: "agentA",
    persona: "a market-note writer that pays for data snippets and files a short daily note",
    tokenName: "Advance Demo Alpha",
    tokenSymbol: "ADVA",
    noteSupplyUsd1e18: 1_000_000_000_000_000_000n, // $1 cap (AdvanceHub.MIN_NOTE_SUPPLY floor)
    floorCents: 80,
    minPrincipal: 300_000n, // $0.30
    bidAmount: 1_000_000n, // $1.00
    bidCents: 90,
    auctionBlocks: 500n,
    drawLimit: 1_000_000n,
    drawPeriod: 600n,
    gracePeriod: 3600n,
  },
  {
    name: "agentB",
    persona: "a research assistant that pulls one paid briefing per tick and summarizes it",
    tokenName: "Advance Demo Bravo",
    tokenSymbol: "ADVB",
    noteSupplyUsd1e18: 1_000_000_000_000_000_000n, // $1 cap
    floorCents: 80,
    minPrincipal: 300_000n,
    bidAmount: 1_000_000n,
    bidCents: 90,
    auctionBlocks: 400n,
    drawLimit: 1_000_000n,
    drawPeriod: 600n,
    gracePeriod: 3600n,
  },
  {
    name: "agentC",
    persona: "a scheduler agent that borrows against its pool but never files revenue-generating work",
    tokenName: "Advance Demo Charlie",
    tokenSymbol: "ADVC",
    noteSupplyUsd1e18: 1_000_000_000_000_000_000n,
    floorCents: 80,
    minPrincipal: 300_000n,
    bidAmount: 800_000n, // $0.80
    bidCents: 90,
    auctionBlocks: 400n,
    drawLimit: 800_000n,
    drawPeriod: 600n,
    gracePeriod: 240n, // 4 minutes - short enough to wait out in real time
  },
];

function provisionParamsFor(env: DemoEnv, spec: AgentSpec): ProvisionAgentParams {
  return {
    name: spec.name,
    persona: spec.persona,
    tokenName: spec.tokenName,
    tokenSymbol: spec.tokenSymbol,
    perCallCap: 10_000n, // $0.01
    maxAuthWindow: 300n,
    llmUrl: `http://127.0.0.1:${process.env["X402_LLM_PORT"] ?? 8402}/v1`,
    llmModel: process.env["LLM_MODEL"] ?? "mistral-small-3-2-24b-instruct",
    dataUrl: `http://127.0.0.1:${process.env["X402_LLM_PORT"] ?? 8402}`,
    underwriterUrl: "unused",
  };
}

function bidderWallet(env: DemoEnv) {
  const account = privateKeyToAccount(env.bidderPrivateKey);
  return createWalletClient({ account, chain: baseSepolia, transport: http(env.rpcUrl) });
}

/** Deterministic across reruns (derived only from the agent's own, already-fixed agentId) so a
 * script restart never builds a different term sheet - and so never predicts a different escrow
 * address - for an agent that already moved its beneficiary share once. */
function termSheetNonceFor(agent: AgentRosterEntry): bigint {
  return agent.agentId * 1_000_000n + 1n;
}

async function buildTermSheet(env: DemoEnv, agent: AgentRosterEntry, spec: AgentSpec): Promise<TermSheet> {
  const block = await env.publicClient.getBlock();
  return {
    agentTreasury: getAddress(await env.dynamicKeys.address(agent.treasuryLabel)),
    agentCard: agent.card,
    agentId: agent.agentId,
    feesManager: agent.feesManager,
    poolId: agent.poolId,
    expectedShares: EXPECTED_SHARES,
    noteSupply: spec.noteSupplyUsd1e18,
    floorCents: spec.floorCents,
    minPrincipal: spec.minPrincipal,
    auctionBlocks: spec.auctionBlocks,
    drawLimit: spec.drawLimit,
    drawPeriod: spec.drawPeriod,
    gracePeriod: spec.gracePeriod,
    // A wide, fixed window (not "now + 3600", which would differ across reruns and so change
    // the predicted escrow address) - one day is ample for a script re-invoked every few minutes.
    deadline: block.timestamp - (block.timestamp % 3600n) + 86_400n,
    nonce: termSheetNonceFor(agent),
    memoHash: keccak256(stringToHex(`advance/demo/seed-sepolia/${agent.name}`)),
  };
}

/** Builds, signs and (idempotently) moves the beneficiary share for one agent's loan - separate
 * from actually opening it, so a transient RPC-replica-lag revert on `openLoan` (the escrow's
 * just-written beneficiary share not yet visible to whichever backend serves the next read) can
 * be retried against the exact same term sheet instead of rebuilding one and re-moving a share
 * that already has nowhere left to come from. */
async function prepareLoanForAgent(env: DemoEnv, agent: AgentRosterEntry, spec: AgentSpec) {
  const termSheet = await buildTermSheet(env, agent, spec);
  const digestFromChain = await env.publicClient.readContract({
    address: env.hub,
    abi: advanceHubAbi,
    functionName: "termSheetDigest",
    args: [termSheet],
  });
  const digestLocal = termSheetDigest(termSheet, 84532, env.hub);
  if ((digestFromChain as Hex).toLowerCase() !== digestLocal.toLowerCase()) {
    throw new Error(`termSheetDigest mismatch for ${agent.name}: chain=${digestFromChain} local=${digestLocal}`);
  }
  const signature = await signTermSheet(termSheet, 84532, env.hub, env.underwriterPrivateKey);

  const ctx = buildActionContext(env);
  const predicted = await predictEscrow(ctx, { termSheet });
  await moveBeneficiary(ctx, { label: agent.treasuryLabel, feesManager: agent.feesManager, poolId: agent.poolId, to: predicted });

  return {
    predicted,
    signature,
    termSheet: {
      ...termSheet,
      agentId: termSheet.agentId.toString(),
      expectedShares: termSheet.expectedShares.toString(),
      noteSupply: termSheet.noteSupply.toString(),
      minPrincipal: termSheet.minPrincipal.toString(),
      auctionBlocks: termSheet.auctionBlocks.toString(),
      drawLimit: termSheet.drawLimit.toString(),
      drawPeriod: termSheet.drawPeriod.toString(),
      gracePeriod: termSheet.gracePeriod.toString(),
      deadline: termSheet.deadline.toString(),
      nonce: termSheet.nonce.toString(),
    },
  };
}

type PreparedLoan = Awaited<ReturnType<typeof prepareLoanForAgent>>;

function termSheetFromPrepared(prepared: PreparedLoan["termSheet"]): TermSheet {
  return {
    ...prepared,
    agentId: BigInt(prepared.agentId),
    expectedShares: BigInt(prepared.expectedShares),
    noteSupply: BigInt(prepared.noteSupply),
    minPrincipal: BigInt(prepared.minPrincipal),
    auctionBlocks: BigInt(prepared.auctionBlocks),
    drawLimit: BigInt(prepared.drawLimit),
    drawPeriod: BigInt(prepared.drawPeriod),
    gracePeriod: BigInt(prepared.gracePeriod),
    deadline: BigInt(prepared.deadline),
    nonce: BigInt(prepared.nonce),
  } as TermSheet;
}

/** Sends `openLoan` for an already-prepared term sheet, retrying a few times on
 * `EscrowNotBeneficiary` - the escrow's beneficiary share was already moved to the right address
 * (see {@link prepareLoanForAgent}), so a revert here means only that this RPC call landed on a
 * backend whose view of that write hasn't caught up yet, not that anything is actually wrong. */
async function sendOpenLoan(env: DemoEnv, agent: AgentRosterEntry, prepared: PreparedLoan, attempts = 6, delayMs = 5000) {
  const termSheet = termSheetFromPrepared(prepared.termSheet);
  const ctx = buildActionContext(env);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const { hash } = await openLoan(ctx, { label: agent.treasuryLabel, termSheet, signature: prepared.signature });
      // The decoded return value comes from `simulateContract`'s pre-broadcast simulation, which
      // can predict the wrong loan id if the hub's `loanCount` changes between simulating and
      // actually mining this tx (a concurrent loan opening) - `liveLoanOf(card)` reads the real,
      // just-mined state instead of trusting that prediction. Retried: even after
      // `waitForTransactionReceipt` confirms the tx mined, a load-balanced RPC's next read can
      // still land on a replica that hasn't caught up to that block yet.
      let loanId = 0n;
      for (let j = 0; j < 6 && loanId === 0n; j++) {
        loanId = (await env.publicClient.readContract({
          address: env.hub,
          abi: advanceHubAbi,
          functionName: "liveLoanOf",
          args: [agent.card],
        })) as bigint;
        if (loanId === 0n) await new Promise((r) => setTimeout(r, 3000));
      }
      if (loanId === 0n) throw new Error(`liveLoanOf(${agent.card}) still 0 after openLoan (tx ${hash})`);
      return { hash, loanId: loanId.toString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/EscrowNotBeneficiary/.test(message)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/** Same steps as `@advance/agent-kit`'s `bidOnNote` (USDC approve -> Permit2 approve -> submitBid),
 * but with an explicit pause after each of the first two sends: this RPC's `pending` nonce count
 * measurably lags a transaction it just finished mining, so issuing the next send immediately
 * after `waitForTransactionReceipt` resolves can still collide ("replacement transaction
 * underpriced") even on a key nothing else ever touches. */
async function bidForAgent(env: DemoEnv, loanId: bigint, spec: AgentSpec) {
  const loan = (await env.publicClient.readContract({ address: env.hub, abi: advanceHubAbi, functionName: "loan", args: [loanId] })) as {
    auction: Address;
  };
  const auction = getAddress(loan.auction);
  const wallet = bidderWallet(env);
  const amount = spec.bidAmount;

  const approveHash = await withNonceRetry(() =>
    wallet.writeContract({ address: env.usdc, abi: erc20Abi, functionName: "approve", args: [env.permit2, amount] }),
  );
  await env.publicClient.waitForTransactionReceipt({ hash: approveHash });
  await new Promise((r) => setTimeout(r, 4000));

  const block = await env.publicClient.getBlock();
  const expiration = block.timestamp + 3600n;
  const permit2Hash = await withNonceRetry(() =>
    wallet.writeContract({ address: env.permit2, abi: permit2Abi, functionName: "approve", args: [env.usdc, auction, amount, expiration] }),
  );
  await env.publicClient.waitForTransactionReceipt({ hash: permit2Hash });
  await new Promise((r) => setTimeout(r, 4000));

  const maxPriceQ96 = TICK_Q96 * BigInt(spec.bidCents);
  const prevTickPriceQ96 = TICK_Q96 * BigInt(spec.floorCents);
  const { request, result } = await withNonceRetry(() =>
    env.publicClient.simulateContract({
      address: auction,
      abi: ccaAbi,
      functionName: "submitBid",
      args: [maxPriceQ96, amount, env.bidderAddress, prevTickPriceQ96, "0x" as Hex],
      account: wallet.account,
    }),
  );
  const hash = await withNonceRetry(() => wallet.writeContract(request));
  await env.publicClient.waitForTransactionReceipt({ hash });
  const bidId = result as bigint;

  await env.events.append({
    agent: "bidder",
    kind: "bidOnNote",
    data: { auction, maxPriceQ96: maxPriceQ96.toString(), amount: amount.toString(), bidId: bidId.toString() },
    txHash: hash,
  });
  return { hash, bidId: bidId.toString(), auction };
}

/** Exits the bidder's auction position and claims its note tokens - required once, after the
 * auction has ended, before `RevenueNote.claim`/`claimFor` can see any balance to pay out
 * against: `submitBid` only records the bid, the note ERC20 balance itself stays parked in the
 * auction contract until `exitBid`/`claimTokens` release it to the bidder. */
async function exitAndClaimBidTokens(env: DemoEnv, auction: Address, bidId: bigint) {
  const wallet = bidderWallet(env);
  const exitHash = await withNonceRetry(() =>
    wallet.writeContract({ address: auction, abi: ccaAbi, functionName: "exitBid", args: [bidId] }),
  );
  await env.publicClient.waitForTransactionReceipt({ hash: exitHash });
  await new Promise((r) => setTimeout(r, 3000));
  const claimHash = await withNonceRetry(() =>
    wallet.writeContract({ address: auction, abi: ccaAbi, functionName: "claimTokens", args: [bidId] }),
  );
  await env.publicClient.waitForTransactionReceipt({ hash: claimHash });
  return { exitHash, claimHash };
}

async function endBlockFor(env: DemoEnv, auction: Address): Promise<bigint> {
  return env.publicClient.readContract({ address: auction, abi: ccaAbi, functionName: "endBlock" }) as Promise<bigint>;
}

async function settleForAgent(env: DemoEnv, loanId: bigint) {
  const ctx = buildActionContext(env);
  const loan = (await env.publicClient.readContract({ address: env.hub, abi: advanceHubAbi, functionName: "loan", args: [loanId] })) as {
    creditLine: Address;
    escrow: Address;
  };
  const { hash } = await withNonceRetry(() => settleAuction(ctx, { label: "bidder", creditLine: loan.creditLine }));
  const principal = (await env.publicClient.readContract({ address: loan.creditLine, abi: creditLineAbi, functionName: "principal" })) as bigint;
  return { hash, creditLine: getAddress(loan.creditLine), escrow: getAddress(loan.escrow), principal: principal.toString() };
}

const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

/** Wraps `ethIn` ETH into WETH, then swaps it for the agent token, then swaps roughly half the
 * received tokens back - real volume through the pool's own v4 hook, which is what lets its
 * Doppler fees manager accrue real fees for the escrow to later collect. */
async function generateSwapVolume(env: DemoEnv, agent: AgentRosterEntry, ethIn: bigint): Promise<Hex[]> {
  const wallet = bidderWallet(env);
  const hashes: Hex[] = [];

  const depositHash = await withNonceRetry(() => wallet.writeContract({ address: env.weth, abi: WETH_ABI, functionName: "deposit", args: [], value: ethIn }));
  await env.publicClient.waitForTransactionReceipt({ hash: depositHash });
  await new Promise((r) => setTimeout(r, 3000));
  hashes.push(depositHash);

  // `getPoolKey` declares five separate named outputs (not one tuple), so viem decodes it as a
  // plain positional array, not an object - matching `keeper.ts`'s `pendingHarvestWeth` reader.
  const [currency0, currency1, fee, tickSpacing, hooks] = (await env.publicClient.readContract({
    address: agent.feesManager,
    abi: feesManagerAbi,
    functionName: "getPoolKey",
    args: [agent.poolId],
  })) as readonly [Address, Address, number, number, Address];
  const wethIsCurrency0 = currency0.toLowerCase() === env.weth.toLowerCase();
  const v4Key = { currency0, currency1, fee, tickSpacing, hooks };

  const approveWeth = await withNonceRetry(() => wallet.writeContract({ address: env.weth, abi: erc20Abi, functionName: "approve", args: [env.sepoliaSwapper, ethIn] }));
  await env.publicClient.waitForTransactionReceipt({ hash: approveWeth });
  await new Promise((r) => setTimeout(r, 3000));
  hashes.push(approveWeth);

  const buyHash = await withNonceRetry(() => wallet.writeContract({
    address: env.sepoliaSwapper,
    abi: [
      {
        type: "function",
        name: "swapExactIn",
        stateMutability: "nonpayable",
        inputs: [
          {
            name: "key",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint256" },
        ],
        outputs: [
          { name: "delta0", type: "int128" },
          { name: "delta1", type: "int128" },
        ],
      },
    ] as const,
    functionName: "swapExactIn",
    args: [v4Key, wethIsCurrency0, ethIn],
  }));
  await env.publicClient.waitForTransactionReceipt({ hash: buyHash });
  await new Promise((r) => setTimeout(r, 3000));
  hashes.push(buyHash);

  const tokenBalance = (await env.publicClient.readContract({
    address: agent.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [env.bidderAddress],
  })) as bigint;
  const sellAmount = tokenBalance / 2n;
  if (sellAmount > 0n) {
    const approveToken = await withNonceRetry(() =>
      wallet.writeContract({ address: agent.token, abi: erc20Abi, functionName: "approve", args: [env.sepoliaSwapper, sellAmount] }),
    );
    await env.publicClient.waitForTransactionReceipt({ hash: approveToken });
    await new Promise((r) => setTimeout(r, 3000));
    hashes.push(approveToken);

    const sellHash = await withNonceRetry(() => wallet.writeContract({
      address: env.sepoliaSwapper,
      abi: [
        {
          type: "function",
          name: "swapExactIn",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "key",
              type: "tuple",
              components: [
                { name: "currency0", type: "address" },
                { name: "currency1", type: "address" },
                { name: "fee", type: "uint24" },
                { name: "tickSpacing", type: "int24" },
                { name: "hooks", type: "address" },
              ],
            },
            { name: "zeroForOne", type: "bool" },
            { name: "amountIn", type: "uint256" },
          ],
          outputs: [
            { name: "delta0", type: "int128" },
            { name: "delta1", type: "int128" },
          ],
        },
      ] as const,
      functionName: "swapExactIn",
      args: [v4Key, !wethIsCurrency0, sellAmount],
    }));
    await env.publicClient.waitForTransactionReceipt({ hash: sellHash });
    hashes.push(sellHash);
  }

  return hashes;
}

async function loanStatus(env: DemoEnv, loanId: bigint): Promise<number> {
  const loan = (await env.publicClient.readContract({ address: env.hub, abi: advanceHubAbi, functionName: "loan", args: [loanId] })) as {
    status: number;
  };
  return loan.status;
}

/** Attempts a gateway-level refusal: a synthetic 402 offering a non-allowlisted payee, answered
 * entirely client-side by `precheck` - no signature ever requested. */
async function demonstrateGatewayRefusal(env: DemoEnv, agent: AgentRosterEntry) {
  const attacker = "0x000000000000000000000000000000000000dEaD" as Address;
  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    asset: env.usdc,
    amount: "1000",
    payTo: attacker,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://demo.invalid/gateway-refusal-test" },
    accepts: [requirements],
  };
  const fakeFetch = (async () =>
    new Response(JSON.stringify(paymentRequired), { status: 402, headers: { "content-type": "application/json" } })) as typeof fetch;

  const cardFetch = createCardFetch({ agent: agent.name, card: agent.card, keys: env.dynamicKeys, events: env.events, chain: env.publicClient, fetchImpl: fakeFetch });
  const response = await cardFetch("https://demo.invalid/gateway-refusal-test");
  const body = (await response.json().catch(() => undefined)) as { refused?: boolean; reason?: string } | undefined;
  return { status: response.status, refused: body?.refused === true, reason: body?.reason };
}

/** Bypasses the gateway entirely: signs a valid-shaped `TransferWithAuthorization` blob for a
 * non-allowlisted payee (the real card owner key, via Dynamic, happily signs it - `cardSigner`
 * only checks the message's shape, never the payee) and submits it straight to the real x402
 * facilitator, which discovers the refusal on-chain via `AgentCard.isValidSignature`. */
async function demonstrateOnchainRefusal(env: DemoEnv, agent: AgentRosterEntry) {
  const attacker = "0x000000000000000000000000000000000000dEaD" as Address;
  const requirements = {
    scheme: "exact",
    network: "eip155:84532" as const,
    asset: env.usdc,
    amount: "1000",
    payTo: attacker,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://demo.invalid/onchain-refusal-test" },
    accepts: [requirements],
  };
  const client = new x402Client();
  const signer = cardSigner(agent.card, agent.ownerLabel, { keys: env.dynamicKeys, usdc: env.usdc, chainId: 84532 });
  registerExactEvmScheme(client, { signer, networks: ["eip155:84532"] });
  const paymentPayload = await client.createPaymentPayload(paymentRequired);

  const facilitator = new HTTPFacilitatorClient({ url: process.env["X402_FACILITATOR_URL"] ?? "https://x402.org/facilitator" });
  const verifyResult = await facilitator.verify(paymentPayload, requirements);
  await env.events.append({
    agent: agent.name,
    kind: "refusal",
    data: { layer: "card-1271", reason: verifyResult.invalidReason ?? "unknown", isValid: verifyResult.isValid, payTo: attacker },
  });
  return verifyResult;
}

/** Attempts an over-limit draw, expecting an on-chain revert (`CreditLine.DrawLimitExceeded`). */
async function demonstrateOverLimitDraw(env: DemoEnv, agent: AgentRosterEntry, creditLine: Address, overAmount: bigint) {
  const ctx = buildActionContext(env);
  for (let i = 0; i < 5; i++) {
    try {
      await drawCredit(ctx, { ownerLabel: agent.ownerLabel, card: agent.card, creditLine, amount: overAmount });
      return { reverted: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/underpriced|nonce too low|already known/i.test(message)) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      const onChain = /DrawLimitExceeded/i.test(message);
      await env.events.append({
        agent: agent.name,
        kind: "refusal",
        data: { layer: "credit-line", reason: onChain ? "DrawLimitExceeded" : "unknown", onChain, requested: overAmount.toString(), message },
      });
      return { reverted: true, onChain, message };
    }
  }
  throw new Error("demonstrateOverLimitDraw: exhausted retries on nonce contention");
}

async function main(): Promise<void> {
  const env = await loadDemoEnv();
  const ck = new Checkpoint(resolvePath(env.storeDir, "seed-checkpoint.json"));

  // --- shared demo x402 service (LLM + data endpoints, real facilitator settlement) ---
  const llmPort = Number(process.env["X402_LLM_PORT"] ?? 8402);
  const serviceConfig = loadConfig({
    ...process.env,
    LLM_BASE_URL: process.env["LLM_BASE_URL"]!,
    LLM_API_KEY: process.env["LLM_API_KEY"],
    SERVICE_PAYTO: env.servicePayTo,
    CHAIN_ID: "84532",
    REDTEAM: "1",
  });
  const running = await startServer(serviceConfig, { port: llmPort });
  console.log(`x402-llm service up on :${running.port}`);

  try {
    const agents: Record<string, AgentRosterEntry> = {};
    for (const spec of AGENT_SPECS) {
      const json = await ck.step(`provision-${spec.name}`, async () => rosterToJson(await provisionAgent(env, provisionParamsFor(env, spec))));
      agents[spec.name] = rosterFromJson(json);
    }

    const loanIds: Record<string, string> = {};
    const auctions: Record<string, Address> = {};
    const bidIds: Record<string, string> = {};
    const prepared: Record<string, PreparedLoan> = {};
    for (const spec of AGENT_SPECS) {
      prepared[spec.name] = await ck.step(`prepareloan-${spec.name}`, () => prepareLoanForAgent(env, agents[spec.name]!, spec));
    }
    for (const spec of AGENT_SPECS) {
      const result = await ck.step(`openloan-${spec.name}`, () => sendOpenLoan(env, agents[spec.name]!, prepared[spec.name]!));
      loanIds[spec.name] = result.loanId;
    }
    for (const spec of AGENT_SPECS) {
      const result = await ck.step(`bid-${spec.name}`, () => bidForAgent(env, BigInt(loanIds[spec.name]!), spec));
      auctions[spec.name] = result.auction;
      bidIds[spec.name] = result.bidId;
    }

    const endBlocks = await Promise.all(AGENT_SPECS.map((spec) => endBlockFor(env, auctions[spec.name]!)));
    const maxEndBlock = endBlocks.reduce((a, b) => (b > a ? b : a), 0n);
    const currentBlock = await env.publicClient.getBlockNumber();
    if (currentBlock < maxEndBlock) {
      const remaining = maxEndBlock - currentBlock;
      console.log(`waiting for auctions to end: at block ${currentBlock}, need ${maxEndBlock} (~${remaining * BLOCK_TIME_SECONDS}s more). Re-run this script to continue.`);
      return;
    }

    const settlements: Record<string, { creditLine: Address; escrow: Address }> = {};
    for (const spec of AGENT_SPECS) {
      const result = await ck.step(`settle-${spec.name}`, () => settleForAgent(env, BigInt(loanIds[spec.name]!)));
      settlements[spec.name] = { creditLine: result.creditLine, escrow: result.escrow };
    }

    // ---------------- Agent A: full lifecycle to Repaid ----------------
    const a = agents["agentA"]!;
    const aSpec = AGENT_SPECS[0]!;
    const aCreditLine = settlements["agentA"]!.creditLine;
    const aEscrow = settlements["agentA"]!.escrow;

    await ck.step("agentA-draw", async () => {
      const ctx = buildActionContext(env);
      // The CCA's clearing price can raise slightly less than the bid amount, so the real
      // per-period limit (`availableThisPeriod`) can be a hair under the term sheet's
      // `drawLimit` - draw exactly what's actually available, not the nominal limit.
      const available = (await env.publicClient.readContract({ address: aCreditLine, abi: creditLineAbi, functionName: "availableThisPeriod" })) as bigint;
      const { hash } = await withNonceRetry(() => drawCredit(ctx, { ownerLabel: a.ownerLabel, card: a.card, creditLine: aCreditLine, amount: available }));
      return { hash, amount: available.toString() };
    });
    await ck.step("agentA-draw-overlimit", () => demonstrateOverLimitDraw(env, a, aCreditLine, 1n));
    await new Promise((r) => setTimeout(r, 8000));
    await ck.step("agentA-spend", () => withNonceRetry(() => tickAgent(env, a)));

    for (let round = 1; round <= MAX_HARVEST_ROUNDS; round++) {
      const status = await loanStatus(env, BigInt(loanIds["agentA"]!));
      if (status === 3 /* Repaid */) break;
      await ck.step(`agentA-swap-${round}`, () => withNonceRetry(() => generateSwapVolume(env, a, parseEther("0.0015"))));
      await ck.step(`agentA-harvest-${round}`, async () => {
        const ctx = buildActionContext(env);
        const { hash } = await withNonceRetry(() => harvest(ctx, { label: "bidder", escrow: aEscrow, minUsdcOut: 0n }));
        return { hash };
      });
    }
    const finalStatusA = await loanStatus(env, BigInt(loanIds["agentA"]!));
    await ck.step("agentA-final-status", async () => ({ status: finalStatusA }));

    if (finalStatusA === 3) {
      await ck.step("agentA-feedback", async () => {
        const lastIndex = (await env.publicClient.readContract({
          address: env.reputationRegistryAddress,
          abi: REPUTATION_REGISTRY_ABI,
          functionName: "getLastIndex",
          args: [a.agentId, env.hub],
        })) as bigint;
        const feedback = (await env.publicClient.readContract({
          address: env.reputationRegistryAddress,
          abi: REPUTATION_REGISTRY_ABI,
          functionName: "readFeedback",
          args: [a.agentId, env.hub, lastIndex],
        })) as [bigint, number, string, string, boolean];
        return { lastIndex: lastIndex.toString(), value: feedback[0].toString(), tag1: feedback[2], tag2: feedback[3] };
      });
      await ck.step("agentA-exit-claim-tokens", () => exitAndClaimBidTokens(env, auctions["agentA"]!, BigInt(bidIds["agentA"]!)));
      await ck.step("agentA-note-claim", async () => {
        const loan = (await env.publicClient.readContract({ address: env.hub, abi: advanceHubAbi, functionName: "loan", args: [BigInt(loanIds["agentA"]!)] })) as { note: Address };
        const ctx = buildActionContext(env);
        const { hash } = await withNonceRetry(() => claim(ctx, { label: "bidder", note: loan.note }));
        return { hash };
      });
    }

    // ---------------- Agent B: active borrower, left mid-loan ----------------
    const b = agents["agentB"]!;
    const bCreditLine = settlements["agentB"]!.creditLine;
    await ck.step("agentB-draw", async () => {
      const ctx = buildActionContext(env);
      const available = (await env.publicClient.readContract({ address: bCreditLine, abi: creditLineAbi, functionName: "availableThisPeriod" })) as bigint;
      const { hash } = await withNonceRetry(() => drawCredit(ctx, { ownerLabel: b.ownerLabel, card: b.card, creditLine: bCreditLine, amount: available }));
      return { hash, amount: available.toString() };
    });
    await new Promise((r) => setTimeout(r, 8000));
    await ck.step("agentB-spend", () => withNonceRetry(() => tickAgent(env, b)));

    // ---------------- Agent C: default path ----------------
    const c = agents["agentC"]!;
    const cSpec = AGENT_SPECS[2]!;
    const cEscrow = settlements["agentC"]!.escrow;
    const lastRevenueAt = (await env.publicClient.readContract({ address: cEscrow, abi: revenueEscrowAbi, functionName: "lastRevenueAt" })) as bigint;
    const nowBlock = await env.publicClient.getBlock();
    const eligibleAt = lastRevenueAt + cSpec.gracePeriod;
    if (nowBlock.timestamp <= eligibleAt) {
      console.log(`agentC not yet past grace period: now=${nowBlock.timestamp} eligibleAt=${eligibleAt} (~${eligibleAt - nowBlock.timestamp}s more). Re-run this script to continue.`);
      return;
    }
    await ck.step("agentC-markDefault", () => keeperMarkDefault(env, BigInt(loanIds["agentC"]!)));
    await ck.step("agentC-exit-claim-tokens", () => exitAndClaimBidTokens(env, auctions["agentC"]!, BigInt(bidIds["agentC"]!)));
    await ck.step("agentC-noteholder-claim", async () => {
      const loan = (await env.publicClient.readContract({ address: env.hub, abi: advanceHubAbi, functionName: "loan", args: [BigInt(loanIds["agentC"]!)] })) as { note: Address };
      const ctx = buildActionContext(env);
      const { hash } = await withNonceRetry(() => claim(ctx, { label: "bidder", note: loan.note }));
      return { hash };
    });
    await ck.step("agentC-feedback", async () => {
      const lastIndex = (await env.publicClient.readContract({
        address: env.reputationRegistryAddress,
        abi: REPUTATION_REGISTRY_ABI,
        functionName: "getLastIndex",
        args: [c.agentId, env.hub],
      })) as bigint;
      const feedback = (await env.publicClient.readContract({
        address: env.reputationRegistryAddress,
        abi: REPUTATION_REGISTRY_ABI,
        functionName: "readFeedback",
        args: [c.agentId, env.hub, lastIndex],
      })) as [bigint, number, string, string, boolean];
      return { lastIndex: lastIndex.toString(), value: feedback[0].toString(), tag1: feedback[2], tag2: feedback[3] };
    });

    // ---------------- refusals ----------------
    await ck.step("refusal-gateway", () => demonstrateGatewayRefusal(env, a));
    await ck.step("refusal-onchain-1271", () => demonstrateOnchainRefusal(env, a));

    console.log("seed-sepolia: all steps complete");
  } finally {
    await running.close();
  }
}

async function keeperMarkDefault(env: DemoEnv, loanId: bigint) {
  const ctx = buildActionContext(env);
  const { hash } = await withNonceRetry(() => markDefault(ctx, { label: "bidder", loanId }));
  return { hash };
}

const REPUTATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "readFeedback",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
      { name: "idx", type: "uint64" },
    ],
    outputs: [
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "isRevoked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
