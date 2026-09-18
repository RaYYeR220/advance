import { encodeFunctionData, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { reputationRegistryAbi, ZERO_ADDRESS, type TermSheet } from "@advance/core";
import {
  advanceHubAbi,
  agentCardAbi,
  creditLineAbi,
  dopplerFeesManagerAbi,
  erc20Abi,
  iccaAbi,
  permit2Abi,
  revenueEscrowAbi,
  revenueNoteAbi,
} from "./abis/index.js";
import {
  loanStatusFromIndex,
  type ApproveDecision,
  type AuctionView,
  type Erc8004FeedbackView,
  type LoanStatus,
  type LoanView,
  type TxRequest,
} from "./types.js";

/** Everything a read/write in this module needs to talk to one `AdvanceHub` deployment. */
export interface ChainContext {
  publicClient: PublicClient;
  hub: Address;
}

/** Canonical Uniswap Permit2 address — the same deterministic deployment on every chain this
 * SDK targets (Base mainnet and Base Sepolia), so it's a constant rather than per-chain config. */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** How long a Permit2 allowance `bid` grants the auction stays valid for. */
const PERMIT2_DEFAULT_EXPIRY_SECONDS = 3600;

/** Q96 fixed-point unit. */
export const Q96 = 1n << 96n;

/** CCA tick spacing: $0.01 per note, as a Q96 price in USDC-wei per note-wei. Mirrors
 * `AdvanceHub.TICK_SPACING_Q96` exactly (`uint256(1e4 << 96) / 1e18`). */
export const TICK_SPACING_Q96 = (10_000n * Q96) / 10n ** 18n;

const MAX_UINT160 = (1n << 160n) - 1n;

/** Converts a whole-cent price (e.g. `80` for $0.80/note) to the Q96 price CCA bids are
 * denominated in. Always lands on a tick (a multiple of `TICK_SPACING_Q96`), since it's a
 * whole-cent input times the tick size itself. */
export function centsToQ96(cents: number): bigint {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`centsToQ96: cents must be a non-negative integer, got ${cents}`);
  }
  return BigInt(cents) * TICK_SPACING_Q96;
}

/** The inverse of `centsToQ96`. Throws if `priceQ96` isn't an exact multiple of the tick
 * spacing (a price that never came from a whole-cent input). */
export function q96ToCents(priceQ96: bigint): number {
  if (priceQ96 % TICK_SPACING_Q96 !== 0n) {
    throw new Error(`q96ToCents: ${priceQ96} is not a multiple of the auction's tick spacing (${TICK_SPACING_Q96})`);
  }
  return Number(priceQ96 / TICK_SPACING_Q96);
}

/** `ceil(notes * priceQ96 / Q96)` — the worst-case currency commitment a bid of `notes` notes at
 * up to `priceQ96` per note can cost, used to size the Permit2 allowance `bid` grants the
 * auction (see `writeBid`). */
export function bidCurrencyCeiling(notes: bigint, priceQ96: bigint): bigint {
  return (notes * priceQ96 + Q96 - 1n) / Q96;
}

function requireAccount(wallet: WalletClient): Account {
  if (!wallet.account) {
    throw new Error("advance sdk: wallet client has no bound account — construct it with `account` set");
  }
  return wallet.account;
}

export interface HubConfig {
  usdc: Address;
  weth: Address;
  ccaFactory: Address;
  router: Address;
  ethUsdFeed: Address;
  sequencerFeed: Address;
  reputationRegistry: Address;
  maxStaleness: bigint;
  slippageBps: number;
  minActivityUsdc: bigint;
}

/** The hub's immutable deployment configuration (`AdvanceHub.config()`). Never changes for a
 * given hub address — safe for a caller to cache for the process's lifetime. */
export async function readHubConfig(ctx: ChainContext): Promise<HubConfig> {
  return ctx.publicClient.readContract({
    address: ctx.hub,
    abi: advanceHubAbi,
    functionName: "config",
  }) as Promise<HubConfig>;
}

/** The escrow address `openLoan` would deploy for `ts` — `AdvanceHub.predictEscrow`, a pure
 * CREATE2 view, so it's exact and available before the loan is ever opened. */
export async function readPredictEscrow(ctx: ChainContext, ts: TermSheet): Promise<Address> {
  return ctx.publicClient.readContract({
    address: ctx.hub,
    abi: advanceHubAbi,
    functionName: "predictEscrow",
    args: [ts],
  }) as Promise<Address>;
}

interface RawLoanRecord {
  ts: TermSheet;
  escrow: Address;
  note: Address;
  creditLine: Address;
  auction: Address;
  status: number;
  openedAt: bigint;
  activatedAt: bigint;
}

/** `AdvanceHub.loan(loanId)` verbatim — the addresses of a loan's contracts and its raw status
 * index, without the extra note/credit-line/escrow reads `readLoan` also makes. Used internally
 * wherever only the addresses are needed (`writeBid`/`writeDraw`/`readAuction`). */
export async function readLoanRecord(ctx: ChainContext, loanId: bigint): Promise<RawLoanRecord> {
  return ctx.publicClient.readContract({
    address: ctx.hub,
    abi: advanceHubAbi,
    functionName: "loan",
    args: [loanId],
  }) as Promise<RawLoanRecord>;
}

const ZERO_LOAN_AMOUNTS = { cap: 0n, repaid: 0n, principal: 0n, drawn: 0n, available: 0n, lastRevenueAt: 0n };

/** A loan's full on-chain state: `AdvanceHub.loan(loanId)` plus its note's cap/repaid, its
 * credit line's principal/drawn/available and its escrow's `lastRevenueAt`. For an id that
 * never opened a loan (`status` `None`, every contract address zero), the amounts are all `0`
 * without attempting reads against the zero address. */
export async function readLoan(ctx: ChainContext, loanId: bigint): Promise<LoanView> {
  const raw = await readLoanRecord(ctx, loanId);
  const status: LoanStatus = loanStatusFromIndex(raw.status);

  const amounts =
    status === "None"
      ? ZERO_LOAN_AMOUNTS
      : await (async () => {
          const [cap, repaid, principal, drawn, available, lastRevenueAt] = await Promise.all([
            ctx.publicClient.readContract({ address: raw.note, abi: revenueNoteAbi, functionName: "capUsdc" }),
            ctx.publicClient.readContract({ address: raw.note, abi: revenueNoteAbi, functionName: "totalRepaid" }),
            ctx.publicClient.readContract({ address: raw.creditLine, abi: creditLineAbi, functionName: "principal" }),
            ctx.publicClient.readContract({ address: raw.creditLine, abi: creditLineAbi, functionName: "totalDrawn" }),
            ctx.publicClient.readContract({
              address: raw.creditLine,
              abi: creditLineAbi,
              functionName: "availableThisPeriod",
            }),
            ctx.publicClient.readContract({ address: raw.escrow, abi: revenueEscrowAbi, functionName: "lastRevenueAt" }),
          ]);
          return {
            cap: cap as bigint,
            repaid: repaid as bigint,
            principal: principal as bigint,
            drawn: drawn as bigint,
            available: available as bigint,
            lastRevenueAt: lastRevenueAt as bigint,
          };
        })();

  return {
    loanId,
    status,
    termSheet: raw.ts,
    escrow: raw.escrow,
    note: raw.note,
    creditLine: raw.creditLine,
    auction: raw.auction,
    openedAt: raw.openedAt,
    activatedAt: raw.activatedAt,
    ...amounts,
  };
}

/** Every loan the hub has ever opened (`1..loanCount`), optionally filtered by status and/or
 * borrower. No indexer: `loanCount` plus one `loan()` read (and its follow-on reads) per id. */
export async function readLoans(
  ctx: ChainContext,
  filter?: { status?: LoanStatus; agent?: Address },
): Promise<LoanView[]> {
  const count = (await ctx.publicClient.readContract({
    address: ctx.hub,
    abi: advanceHubAbi,
    functionName: "loanCount",
  })) as bigint;

  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const loans = await Promise.all(ids.map((loanId) => readLoan(ctx, loanId)));

  return loans.filter((loan) => {
    if (filter?.status !== undefined && loan.status !== filter.status) return false;
    if (filter?.agent !== undefined && loan.termSheet.agentTreasury.toLowerCase() !== filter.agent.toLowerCase()) {
      return false;
    }
    return true;
  });
}

interface CheckpointResult {
  clearingPrice: bigint;
}

/** A loan's CCA auction, read straight off its contract. `graduated`/`clearingPriceQ96` are
 * forced fresh via a `checkpoint()` simulation (an `eth_call`, never actually sent), since both
 * are otherwise only as current as the last real checkpoint-triggering call. */
export async function readAuction(ctx: ChainContext, loanId: bigint): Promise<AuctionView> {
  const raw = await readLoanRecord(ctx, loanId);
  const auction = raw.auction;

  const [endBlock, currency, latestBlockNumber, checkpointResult] = await Promise.all([
    ctx.publicClient.readContract({ address: auction, abi: iccaAbi, functionName: "endBlock" }) as Promise<bigint>,
    ctx.publicClient.readContract({ address: auction, abi: iccaAbi, functionName: "currency" }) as Promise<Address>,
    ctx.publicClient.getBlockNumber(),
    ctx.publicClient.simulateContract({
      address: auction,
      abi: iccaAbi,
      functionName: "checkpoint",
      account: ZERO_ADDRESS,
    }),
  ]);

  const [graduated, raisedSoFar] = await Promise.all([
    ctx.publicClient.readContract({ address: auction, abi: iccaAbi, functionName: "isGraduated" }) as Promise<boolean>,
    ctx.publicClient.readContract({
      address: currency,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [auction],
    }) as Promise<bigint>,
  ]);

  return {
    endBlock,
    blocksLeft: endBlock > latestBlockNumber ? endBlock - latestBlockNumber : 0n,
    graduated,
    currency,
    clearingPriceQ96: (checkpointResult.result as CheckpointResult).clearingPrice,
    requiredCurrencyRaised: raw.ts.minPrincipal,
    raisedSoFar,
  };
}

/**
 * The most recent ERC-8004 reputation-registry entry the hub has posted for `agentId` (client =
 * the hub itself, the same address every `postFeedback` call on the agent/repayment path uses).
 * `null` when the term sheet never carried an agent id (`agentId === 0n`, reputation skipped by
 * design) or the registry has nothing posted yet for this pair (`getLastIndex` returns `0` —
 * `readFeedback`'s `idx` is 1-based and reverts on `0`). Reads the registry address off the
 * hub's own `config()` rather than a hardcoded chain-id branch, so it's correct on mainnet and
 * Sepolia alike.
 */
export async function readAgentFeedback(ctx: ChainContext, agentId: bigint): Promise<Erc8004FeedbackView | null> {
  if (agentId === 0n) return null;

  const { reputationRegistry } = await readHubConfig(ctx);
  const lastIndex = (await ctx.publicClient.readContract({
    address: reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: "getLastIndex",
    args: [agentId, ctx.hub],
  })) as bigint;
  if (lastIndex === 0n) return null;

  const [value, valueDecimals, tag1, tag2, isRevoked] = (await ctx.publicClient.readContract({
    address: reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: "readFeedback",
    args: [agentId, ctx.hub, lastIndex],
  })) as [bigint, number, string, string, boolean];

  return { agentId, index: lastIndex, value, valueDecimals, tag1, tag2, isRevoked, registry: reputationRegistry };
}

/** The calldata `openLoan` sends — encoded here so `prepareApplication` can hand it to a caller
 * that wants to batch/sign it itself, byte-for-byte identical to what `writeOpenLoan` submits. */
export function encodeOpenLoanTx(hub: Address, decision: ApproveDecision): TxRequest {
  return {
    to: hub,
    data: encodeFunctionData({
      abi: advanceHubAbi,
      functionName: "openLoan",
      args: [decision.termSheet, decision.signature],
    }),
    value: 0n,
  };
}

/** The calldata that points the term sheet's Doppler fee-beneficiary shares at `escrow` — must
 * be sent (by whoever currently holds those shares) before `openLoan`, since `openLoan` checks
 * the escrow already holds `expectedShares`. */
export function encodeMoveBeneficiaryTx(escrow: Address, decision: ApproveDecision): TxRequest {
  return {
    to: decision.termSheet.feesManager,
    data: encodeFunctionData({
      abi: dopplerFeesManagerAbi,
      functionName: "updateBeneficiary",
      args: [decision.termSheet.poolId, escrow],
    }),
    value: 0n,
  };
}

/** Sends `openLoan` and resolves once it's simulated and submitted, returning both the tx hash
 * and the loan id the hub will assign it (from the simulated return value — accurate as long as
 * no other loan opens between the simulation and this tx landing). */
export async function writeOpenLoan(
  wallet: WalletClient,
  ctx: ChainContext,
  decision: ApproveDecision,
): Promise<{ hash: Hex; loanId: bigint }> {
  const account = requireAccount(wallet);
  const { request, result } = await ctx.publicClient.simulateContract({
    address: ctx.hub,
    abi: advanceHubAbi,
    functionName: "openLoan",
    args: [decision.termSheet, decision.signature],
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  return { hash, loanId: result };
}

/** Bids `notes` notes up to `maxPriceCents` on `loanId`'s auction: `USDC.approve(Permit2, ...)`,
 * then `Permit2.approve(USDC, auction, ...)`, then `submitBid`, each awaited before the next so
 * every simulation reads state that already reflects the previous step. `owner` of the bid is
 * the wallet's own account; the previous-tick hint defaults to `0` and hook data to empty. */
export async function writeBid(
  wallet: WalletClient,
  ctx: ChainContext,
  p: { loanId: bigint; notes: bigint; maxPriceCents: number },
): Promise<{ hash: Hex; bidId: bigint }> {
  const account = requireAccount(wallet);
  const [record, hubConfig] = await Promise.all([readLoanRecord(ctx, p.loanId), readHubConfig(ctx)]);

  const maxPriceQ96 = centsToQ96(p.maxPriceCents);
  const currencyCeiling = bidCurrencyCeiling(p.notes, maxPriceQ96);
  if (currencyCeiling > MAX_UINT160) {
    throw new Error(
      `advance sdk: bid currency commitment ${currencyCeiling} exceeds Permit2's uint160 allowance range`,
    );
  }
  const expiration = Math.floor(Date.now() / 1000) + PERMIT2_DEFAULT_EXPIRY_SECONDS;

  const approveUsdcHash = await wallet.writeContract({
    address: hubConfig.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [PERMIT2_ADDRESS, currencyCeiling],
    account,
    chain: wallet.chain,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: approveUsdcHash });

  const approvePermit2Hash = await wallet.writeContract({
    address: PERMIT2_ADDRESS,
    abi: permit2Abi,
    functionName: "approve",
    args: [hubConfig.usdc, record.auction, currencyCeiling, expiration],
    account,
    chain: wallet.chain,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: approvePermit2Hash });

  const { request, result: bidId } = await ctx.publicClient.simulateContract({
    address: record.auction,
    abi: iccaAbi,
    functionName: "submitBid",
    args: [maxPriceQ96, p.notes, account.address, 0n, "0x"],
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  return { hash, bidId };
}

/** Claims the caller's owed USDC from `loanId`'s revenue note. Reverts on-chain
 * (`AuctionHolderCannotClaim`) if the caller is the auction's own holder — nothing to claim
 * until it has actually received notes. */
export async function writeClaim(
  wallet: WalletClient,
  ctx: ChainContext,
  loanId: bigint,
): Promise<{ hash: Hex; amount: bigint }> {
  const account = requireAccount(wallet);
  const record = await readLoanRecord(ctx, loanId);
  const { request, result } = await ctx.publicClient.simulateContract({
    address: record.note,
    abi: revenueNoteAbi,
    functionName: "claim",
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  return { hash, amount: result };
}

/** Draws `amount` USDC from `loanId`'s credit line into `card` — the card's own `drawCredit`,
 * callable only by the card's owner. */
export async function writeDraw(
  wallet: WalletClient,
  ctx: ChainContext,
  p: { card: Address; loanId: bigint; amount: bigint },
): Promise<{ hash: Hex }> {
  const account = requireAccount(wallet);
  const record = await readLoanRecord(ctx, p.loanId);
  const { request } = await ctx.publicClient.simulateContract({
    address: p.card,
    abi: agentCardAbi,
    functionName: "drawCredit",
    args: [record.creditLine, p.amount],
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  return { hash };
}
