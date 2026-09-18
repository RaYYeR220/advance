import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  PERMIT2_ADDRESS,
  bidCurrencyCeiling,
  centsToQ96,
  erc20Abi,
  iccaAbi,
  permit2Abi,
  readHubConfig,
  readLoanRecord,
  type ChainContext,
} from "@advance/sdk";

/**
 * The lender wallet's bid flow, one on-chain step at a time: `USDC.approve(Permit2)` →
 * `Permit2.approve(auction)` → `submitBid`. This is the same sequence `@advance/sdk`'s
 * `AdvanceClient.bid`/`writeBid` runs, reimplemented here (not called through the SDK
 * directly) so the UI can report each step's own transaction hash as it lands, rather than
 * only the very last one.
 */

export type BidStepId = "approve-usdc" | "approve-permit2" | "submit-bid";
export type BidStepStatus = "pending" | "confirming" | "done";

export interface BidStepUpdate {
  id: BidStepId;
  status: BidStepStatus;
  hash?: Hex;
}

export interface BidResult {
  hash: Hex;
  bidId: bigint;
}

const PERMIT2_EXPIRY_SECONDS = 3600;

export async function submitBidWithSteps(
  wallet: WalletClient,
  ctx: ChainContext,
  p: { loanId: bigint; notes: bigint; maxPriceCents: number },
  onStep: (update: BidStepUpdate) => void,
): Promise<BidResult> {
  const account = wallet.account;
  if (!account) throw new Error("Connected wallet has no account.");

  const [record, hubConfig] = await Promise.all([readLoanRecord(ctx, p.loanId), readHubConfig(ctx)]);

  const maxPriceQ96 = centsToQ96(p.maxPriceCents);
  const currencyCeiling = bidCurrencyCeiling(p.notes, maxPriceQ96);
  const expiration = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRY_SECONDS;

  onStep({ id: "approve-usdc", status: "pending" });
  const approveUsdcHash = await wallet.writeContract({
    address: hubConfig.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [PERMIT2_ADDRESS, currencyCeiling],
    account,
    chain: wallet.chain,
  });
  onStep({ id: "approve-usdc", status: "confirming", hash: approveUsdcHash });
  await ctx.publicClient.waitForTransactionReceipt({ hash: approveUsdcHash });
  onStep({ id: "approve-usdc", status: "done", hash: approveUsdcHash });

  onStep({ id: "approve-permit2", status: "pending" });
  const approvePermit2Hash = await wallet.writeContract({
    address: PERMIT2_ADDRESS,
    abi: permit2Abi,
    functionName: "approve",
    args: [hubConfig.usdc, record.auction, currencyCeiling, expiration],
    account,
    chain: wallet.chain,
  });
  onStep({ id: "approve-permit2", status: "confirming", hash: approvePermit2Hash });
  await ctx.publicClient.waitForTransactionReceipt({ hash: approvePermit2Hash });
  onStep({ id: "approve-permit2", status: "done", hash: approvePermit2Hash });

  onStep({ id: "submit-bid", status: "pending" });
  const { request, result: bidId } = await ctx.publicClient.simulateContract({
    address: record.auction,
    abi: iccaAbi,
    functionName: "submitBid",
    args: [maxPriceQ96, p.notes, account.address, 0n, "0x"],
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  onStep({ id: "submit-bid", status: "confirming", hash });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  onStep({ id: "submit-bid", status: "done", hash });

  return { hash, bidId };
}

export interface AuctionCtx {
  publicClient: PublicClient;
  auction: Address;
}

/** Exits a bid that filled above the final clearing price, once the auction has ended. */
export async function exitBid(wallet: WalletClient, ctx: AuctionCtx, bidId: bigint): Promise<Hex> {
  const account = wallet.account;
  if (!account) throw new Error("Connected wallet has no account.");
  const { request } = await ctx.publicClient.simulateContract({
    address: ctx.auction,
    abi: iccaAbi,
    functionName: "exitBid",
    args: [bidId],
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Claims the tokens a filled, exited bid is owed. */
export async function claimBidTokens(wallet: WalletClient, ctx: AuctionCtx, bidId: bigint): Promise<Hex> {
  const account = wallet.account;
  if (!account) throw new Error("Connected wallet has no account.");
  const { request } = await ctx.publicClient.simulateContract({
    address: ctx.auction,
    abi: iccaAbi,
    functionName: "claimTokens",
    args: [bidId],
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

function hasStringProp<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return typeof value === "object" && value !== null && key in value && typeof (value as Record<string, unknown>)[key] === "string";
}

/** Turns a thrown wallet/viem error into a plain-language line — rejection and insufficient
 * balance called out by name, everything else falling back to viem's own short message rather
 * than a raw stack trace. */
export function describeWalletError(err: unknown): string {
  const name = hasStringProp(err, "name") ? err.name : "";
  const message = hasStringProp(err, "message") ? err.message : "";
  if (name.includes("UserRejected") || /user rejected/i.test(message)) {
    return "The wallet rejected the request — nothing was sent.";
  }
  const shortMessage = hasStringProp(err, "shortMessage") ? err.shortMessage : undefined;
  const text = shortMessage ?? message;
  if (/insufficient/i.test(text)) {
    return `Insufficient USDC balance for this bid: ${text}`;
  }
  if (text) return text;
  return "Something went wrong sending that bid. Check the steps above for whichever transaction, if any, actually landed.";
}
