import { erc20Abi, type Abi, type Address, type Chain, type Hex, type PublicClient, type Transport, type TransactionReceipt } from "viem";
import {
  advanceHubAbi,
  agentCardAbi,
  ccaAbi,
  creditLineAbi,
  feesManagerAbi,
  identityRegistryAbi,
  permit2Abi,
  revenueEscrowAbi,
  revenueNoteAbi,
  type TermSheet,
} from "@advance/core";
import type { EventSink } from "../events.js";
import { walletClientFor, type ActionKeys } from "./clients.js";

/** Every action returns at least this: the broadcast transaction hash and its receipt, once
 * mined. Some actions (see below) return additional decoded fields alongside it. */
export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

/** Chain-level, loan-independent contract addresses an {@link ActionContext} is built against.
 * Per-loan addresses (card, credit line, escrow, note, auction, fees manager) are passed to each
 * action call instead, since they vary loan to loan. */
export interface ActionAddresses {
  /** `AdvanceHub`. */
  hub: Address;
  /** USDC token loans are raised, drawn and repaid in - also what CCA bids are funded in. */
  usdc: Address;
  /** Uniswap `Permit2` (`AllowanceTransfer`); same address on every EVM chain. */
  permit2: Address;
  /** ERC-8004 `IdentityRegistry`. */
  identityRegistry: Address;
}

/** Everything a `chain/actions.ts` call needs: where to send transactions, how to sign them, the
 * chain's fixed contract addresses, and where to log the resulting events. */
export interface ActionContext {
  chain: Chain;
  /** The transport `publicClient` and every wallet client built here send requests over - an
   * anvil fork's `http(rpcUrl)` in tests, a real RPC in production. */
  transport: Transport;
  publicClient: PublicClient;
  /** Resolves a label to an address and signs transactions with it - a {@link ActionKeys}
   * (typically a `DynamicKeys` instance; tests may supply a fake wrapping a local private key). */
  keys: ActionKeys;
  addresses: ActionAddresses;
  events: EventSink;
}

/** Gas floor for `AdvanceHub.openLoan`: deploys the escrow, credit line and note, then creates a
 * real Uniswap CCA auction through the real factory. Plan-03's ~6.8M estimate undershoots against
 * a real fork (measured ~9-10M against the real CCA factory on Base, vs. the lighter mock the
 * estimate came from) - set with real headroom above that. */
const OPEN_LOAN_GAS = 15_000_000n;
/** Gas floor for `AdvanceHub.markDefault`: freezes the card, returns its funds, freezes the
 * credit line (which can itself distribute to the note) and may close the escrow, all as
 * bounded-gas hooks that confuse naive estimation. Plan-03's ~2.4M estimate undershot against a
 * real fork; set with real headroom above the measured cost. */
const MARK_DEFAULT_GAS = 6_000_000n;
/** Gas floor for `RevenueEscrow.harvest` when it fills the note's cap (swap + distribute + close
 * + hub callback in one call). */
const HARVEST_GAS = 2_500_000n;

/** How long a Permit2 `AllowanceTransfer.approve` stays valid for, measured from the chain's own
 * current block timestamp (never the local clock, which can drift from a warped/forked chain). */
const PERMIT2_EXPIRY_SECONDS = 3600n;

function assertSuccess(hash: Hex, receipt: TransactionReceipt): void {
  if (receipt.status !== "success") {
    throw new Error(`chain/actions: transaction ${hash} reverted (receipt status "${receipt.status}")`);
  }
}

interface WriteParams {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  gas?: bigint;
}

/** Sends a plain contract write from `label`'s wallet client and waits for its receipt. Used for
 * actions whose brief return type is just {@link TxResult} - gas is either auto-estimated (which
 * also surfaces a revert before broadcasting) or, for the three functions with documented gas
 * floors, set explicitly. */
async function writeContractTx(ctx: ActionContext, params: WriteParams): Promise<TxResult> {
  const walletClient = await walletClientFor({
    chain: ctx.chain,
    transport: ctx.transport,
    label: params.label,
    keys: ctx.keys,
  });
  const hash = await walletClient.writeContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
    chain: ctx.chain,
    account: walletClient.account,
    ...(params.gas !== undefined ? { gas: params.gas } : {}),
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  assertSuccess(hash, receipt);
  return { hash, receipt };
}

/** Simulates the call first (an `eth_call` that both validates it and decodes its return value),
 * then sends the exact simulated request from `label`'s wallet client. Used for the three actions
 * whose brief return type includes a decoded on-chain value (`agentId`, `loanId`, `bidId`) - a
 * transaction receipt alone never carries a function's return value. */
async function simulateAndSend(
  ctx: ActionContext,
  params: WriteParams,
): Promise<TxResult & { result: unknown }> {
  const walletClient = await walletClientFor({
    chain: ctx.chain,
    transport: ctx.transport,
    label: params.label,
    keys: ctx.keys,
  });
  const { request, result } = await ctx.publicClient.simulateContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
    account: walletClient.account,
    chain: ctx.chain,
    ...(params.gas !== undefined ? { gas: params.gas } : {}),
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  assertSuccess(hash, receipt);
  return { hash, receipt, result };
}

// ---------------------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------------------

/** Registers `label` as an ERC-8004 agent via `IdentityRegistry.register(agentURI)`. `label`
 * must resolve to an EOA-style key (Dynamic MPC keys qualify): the registry `_safeMint`s the
 * agent id to the caller, which a contract caller could only receive with `onERC721Received`. */
export async function registerAgent(
  ctx: ActionContext,
  params: { label: string; agentURI: string },
): Promise<TxResult & { agentId: bigint }> {
  const { label, agentURI } = params;
  const { hash, receipt, result } = await simulateAndSend(ctx, {
    label,
    address: ctx.addresses.identityRegistry,
    abi: identityRegistryAbi as unknown as Abi,
    functionName: "register",
    args: [agentURI],
  });
  const agentId = result as bigint;
  await ctx.events.append({
    agent: label,
    kind: "registerAgent",
    data: { agentURI, agentId: agentId.toString() },
    txHash: hash,
  });
  return { hash, receipt, agentId };
}

// ---------------------------------------------------------------------------------------
// borrower: onboarding and the loan itself
// ---------------------------------------------------------------------------------------

/** Moves all of `label`'s Doppler fee-beneficiary shares for `poolId` to `to`, via
 * `IDopplerFeesManager.updateBeneficiary`. The agent treasury calls this to point its shares at
 * `AdvanceHub.predictEscrow(ts)` before `openLoan`; `to` is that predicted escrow address. */
export async function moveBeneficiary(
  ctx: ActionContext,
  params: { label: string; feesManager: Address; poolId: Hex; to: Address },
): Promise<TxResult> {
  const { label, feesManager, poolId, to } = params;
  const { hash, receipt } = await writeContractTx(ctx, {
    label,
    address: feesManager,
    abi: feesManagerAbi as unknown as Abi,
    functionName: "updateBeneficiary",
    args: [poolId, to],
  });
  await ctx.events.append({ agent: label, kind: "moveBeneficiary", data: { feesManager, poolId, to }, txHash: hash });
  return { hash, receipt };
}

/** The escrow address `AdvanceHub.openLoan(termSheet, ...)` will deploy (or already has) - a
 * pure view read, not a transaction. The agent treasury reads this to know where to move its fee
 * shares (see {@link moveBeneficiary}) before calling {@link openLoan}. */
export async function predictEscrow(ctx: ActionContext, params: { termSheet: TermSheet }): Promise<Address> {
  const address = await ctx.publicClient.readContract({
    address: ctx.addresses.hub,
    abi: advanceHubAbi as unknown as Abi,
    functionName: "predictEscrow",
    args: [params.termSheet],
  });
  return address as Address;
}

/** Opens a loan from an underwriter-signed term sheet via `AdvanceHub.openLoan(ts, signature)`.
 * `label` must resolve to `termSheet.agentTreasury` - the hub rejects any other caller. The
 * treasury must already have moved its fee shares to `predictEscrow(termSheet)` (see
 * {@link moveBeneficiary}) before this is called. */
export async function openLoan(
  ctx: ActionContext,
  params: { label: string; termSheet: TermSheet; signature: Hex },
): Promise<TxResult & { loanId: bigint }> {
  const { label, termSheet, signature } = params;
  const { hash, receipt, result } = await simulateAndSend(ctx, {
    label,
    address: ctx.addresses.hub,
    abi: advanceHubAbi as unknown as Abi,
    functionName: "openLoan",
    args: [termSheet, signature],
    gas: OPEN_LOAN_GAS,
  });
  const loanId = result as bigint;
  await ctx.events.append({
    agent: label,
    kind: "openLoan",
    data: { loanId: loanId.toString(), agentCard: termSheet.agentCard, noteSupply: termSheet.noteSupply.toString() },
    txHash: hash,
  });
  return { hash, receipt, loanId };
}

// ---------------------------------------------------------------------------------------
// borrower: drawing credit
// ---------------------------------------------------------------------------------------

/** Draws `amount` USDC from `creditLine` into `card`, via `AgentCard.drawCredit(creditLine,
 * amount)`. Only `card`'s owner key may call this - `ownerLabel` must resolve to it. */
export async function drawCredit(
  ctx: ActionContext,
  params: { ownerLabel: string; card: Address; creditLine: Address; amount: bigint },
): Promise<TxResult> {
  const { ownerLabel, card, creditLine, amount } = params;
  const { hash, receipt } = await writeContractTx(ctx, {
    label: ownerLabel,
    address: card,
    abi: agentCardAbi as unknown as Abi,
    functionName: "drawCredit",
    args: [creditLine, amount],
  });
  await ctx.events.append({
    agent: ownerLabel,
    kind: "drawCredit",
    data: { card, creditLine, amount: amount.toString() },
    txHash: hash,
  });
  return { hash, receipt };
}

// ---------------------------------------------------------------------------------------
// lender: bidding on a note's CCA auction
// ---------------------------------------------------------------------------------------

/** Bids `amount` USDC-wei at up to `maxPriceQ96` on a note's CCA auction, as `label`. Runs the
 * full Permit2 path first (`USDC.approve(PERMIT2, amount)` then
 * `Permit2.approve(USDC, auction, amount, expiration)`), then `auction.submitBid(...)`; the
 * returned {@link TxResult} is the bid transaction, not either approval. `prevTickPriceQ96` is
 * the auction's own insertion hint (the caller reads it off the auction/checkpoint state);
 * `maxPriceQ96`/`prevTickPriceQ96` must be `AdvanceHub.TICK_SPACING_Q96` multiples. */
export async function bidOnNote(
  ctx: ActionContext,
  params: { label: string; auction: Address; maxPriceQ96: bigint; amount: bigint; prevTickPriceQ96: bigint },
): Promise<TxResult & { bidId: bigint }> {
  const { label, auction, maxPriceQ96, amount, prevTickPriceQ96 } = params;
  const bidderAddress = (await ctx.keys.address(label)) as Address;

  await writeContractTx(ctx, {
    label,
    address: ctx.addresses.usdc,
    abi: erc20Abi as unknown as Abi,
    functionName: "approve",
    args: [ctx.addresses.permit2, amount],
  });

  const block = await ctx.publicClient.getBlock();
  const expiration = block.timestamp + PERMIT2_EXPIRY_SECONDS;

  await writeContractTx(ctx, {
    label,
    address: ctx.addresses.permit2,
    abi: permit2Abi as unknown as Abi,
    functionName: "approve",
    args: [ctx.addresses.usdc, auction, amount, expiration],
  });

  const { hash, receipt, result } = await simulateAndSend(ctx, {
    label,
    address: auction,
    abi: ccaAbi as unknown as Abi,
    functionName: "submitBid",
    args: [maxPriceQ96, amount, bidderAddress, prevTickPriceQ96, "0x" as Hex],
  });
  const bidId = result as bigint;

  await ctx.events.append({
    agent: label,
    kind: "bidOnNote",
    data: { auction, maxPriceQ96: maxPriceQ96.toString(), amount: amount.toString(), bidId: bidId.toString() },
    txHash: hash,
  });
  return { hash, receipt, bidId };
}

// ---------------------------------------------------------------------------------------
// keepers: settlement, repayment and default (all permissionless on-chain; `label` just pays gas)
// ---------------------------------------------------------------------------------------

/** Settles a loan's CCA auction via `CreditLine.settleAuction()`. Permissionless on-chain -
 * `label` only supplies the paying key. Only callable once the auction's `endBlock` has passed. */
export async function settleAuction(
  ctx: ActionContext,
  params: { label: string; creditLine: Address },
): Promise<TxResult> {
  const { label, creditLine } = params;
  const { hash, receipt } = await writeContractTx(ctx, {
    label,
    address: creditLine,
    abi: creditLineAbi as unknown as Abi,
    functionName: "settleAuction",
    args: [],
  });
  await ctx.events.append({ agent: label, kind: "settleAuction", data: { creditLine }, txHash: hash });
  return { hash, receipt };
}

/** Harvests a loan's escrow via `RevenueEscrow.harvest(minUsdcOut)`: collects Doppler fees,
 * forwards the agent-token leg, and (while the loan is active) swaps WETH to USDC and repays the
 * note. Permissionless on-chain - `label` only supplies the paying key. `minUsdcOut` only raises
 * the escrow's own Chainlink-derived minimum; pass `0n` to rely on the oracle bound alone. */
export async function harvest(
  ctx: ActionContext,
  params: { label: string; escrow: Address; minUsdcOut: bigint },
): Promise<TxResult> {
  const { label, escrow, minUsdcOut } = params;
  const { hash, receipt } = await writeContractTx(ctx, {
    label,
    address: escrow,
    abi: revenueEscrowAbi as unknown as Abi,
    functionName: "harvest",
    args: [minUsdcOut],
    gas: HARVEST_GAS,
  });
  await ctx.events.append({
    agent: label,
    kind: "harvest",
    data: { escrow, minUsdcOut: minUsdcOut.toString() },
    txHash: hash,
  });
  return { hash, receipt };
}

/** Marks a delinquent loan defaulted via `AdvanceHub.markDefault(loanId)`. Permissionless on-chain
 * - `label` only supplies the paying key. Only callable once the loan's escrow has gone longer
 * than its grace period without revenue. */
export async function markDefault(ctx: ActionContext, params: { label: string; loanId: bigint }): Promise<TxResult> {
  const { label, loanId } = params;
  const { hash, receipt } = await writeContractTx(ctx, {
    label,
    address: ctx.addresses.hub,
    abi: advanceHubAbi as unknown as Abi,
    functionName: "markDefault",
    args: [loanId],
    gas: MARK_DEFAULT_GAS,
  });
  await ctx.events.append({ agent: label, kind: "markDefault", data: { loanId: loanId.toString() }, txHash: hash });
  return { hash, receipt };
}

// ---------------------------------------------------------------------------------------
// noteholder: claiming repayment
// ---------------------------------------------------------------------------------------

/** Claims owed USDC from a loan's revenue note, via `RevenueNote.claim()` (paying `label` itself)
 * or, when `holder` is given, `RevenueNote.claimFor(holder)` (paying `holder`, callable by anyone
 * - `label` just supplies the paying key). Reverts on-chain if the payee is the auction's own
 * holder address (unsold notes must be transferred out before they can be claimed). */
export async function claim(
  ctx: ActionContext,
  params: { label: string; note: Address; holder?: Address },
): Promise<TxResult> {
  const { label, note, holder } = params;
  const { hash, receipt } = await writeContractTx(ctx, {
    label,
    address: note,
    abi: revenueNoteAbi as unknown as Abi,
    functionName: holder !== undefined ? "claimFor" : "claim",
    args: holder !== undefined ? [holder] : [],
  });
  await ctx.events.append({ agent: label, kind: "claim", data: { note, holder: holder ?? null }, txHash: hash });
  return { hash, receipt };
}
