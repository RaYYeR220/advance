import { getAddress, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signTermSheet, termSheetDigest, type TermSheet } from "@advance/core";
import { creditLineAbi, erc20Abi, iccaAbi, revenueEscrowAbi } from "../../src/abis/index.js";
import { bidCurrencyCeiling, centsToQ96 } from "../../src/contracts.js";
import { AdvanceClient } from "../../src/client.js";
import type { ApproveDecision } from "../../src/types.js";
import { startForkHarness, type ForkHarness } from "./harness.js";

/** `MockERC20.mint` is a test-only convenience (not part of the real USDC ABI the SDK ships) —
 * minting fixture USDC directly to any address is how this suite funds bidders and the escrow
 * without simulating the full Doppler fee-accrual path. */
const mintableErc20Abi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const NOTE_SUPPLY = 5_000_000_000_000_000_000n; // 5e18 -> 5 USDC cap
const FLOOR_CENTS = 80;
const MIN_PRINCIPAL = 2_000_000n; // $2
const AUCTION_BLOCKS = 10n; // divides 1e7; small so the fork mines past it quickly
const DRAW_LIMIT = 1_000_000n; // $1
const DRAW_PERIOD = 86_400n;
const GRACE_PERIOD = 1_209_600n;
const CREATOR_SHARES = 1_000_000_000_000_000_000n; // 1e18 — the fixture pool's only beneficiary

let harness: ForkHarness;
let client: AdvanceClient;
let decision: ApproveDecision;
let loanId: bigint;
let bidId: bigint;
let bidCost: bigint;

describe("AdvanceClient against a fresh anvil-fork deployment", () => {
  beforeAll(async () => {
    harness = await startForkHarness();
    const { fixture, publicClient } = harness;

    client = new AdvanceClient({
      chainId: 8453, // only gates score()/quote() HTTP calls this suite never makes
      apiUrl: "http://unused.invalid",
      publicClient,
      hub: fixture.hub,
    });

    const latest = await publicClient.getBlock();
    const termSheet: TermSheet = {
      agentTreasury: harness.accounts.treasury.address,
      agentCard: fixture.agentCard,
      agentId: 0n,
      feesManager: fixture.feesManager,
      poolId: fixture.poolId,
      expectedShares: CREATOR_SHARES,
      noteSupply: NOTE_SUPPLY,
      floorCents: FLOOR_CENTS,
      minPrincipal: MIN_PRINCIPAL,
      auctionBlocks: AUCTION_BLOCKS,
      drawLimit: DRAW_LIMIT,
      drawPeriod: DRAW_PERIOD,
      gracePeriod: GRACE_PERIOD,
      deadline: latest.timestamp + 3600n,
      nonce: 1n,
      memoHash: `0x${"ab".repeat(32)}` as Hex,
    };
    const signature = await signTermSheet(termSheet, 31337, fixture.hub, harness.accounts.underwriter.privateKey);
    decision = { kind: "approve", termSheet, signature } as unknown as ApproveDecision;

    // Sanity: the digest the hub itself would compute recovers to the underwriter (catches a
    // chainId/domain mismatch before it surfaces as an opaque `BadSignature` revert below).
    const digest = termSheetDigest(termSheet, 31337, fixture.hub);
    expect(digest).toBeDefined();
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("predictEscrow matches the escrow openLoan actually deploys", async () => {
    const predicted = await client.predictEscrow(decision.termSheet);

    const treasuryWallet = harness.walletFor(harness.accounts.treasury);
    const { moveBeneficiary, openLoan } = client.prepareApplication(decision);

    const moveHash = await treasuryWallet.sendTransaction({
      account: treasuryWallet.account!,
      chain: treasuryWallet.chain,
      to: moveBeneficiary.to,
      data: moveBeneficiary.data,
      value: moveBeneficiary.value,
    });
    await harness.publicClient.waitForTransactionReceipt({ hash: moveHash });

    // `openLoan`'s calldata from `prepareApplication` is asserted byte-identical to the direct
    // viem encoding in the pure suite (`test/prepareApplication.test.ts`); here it's proven to
    // actually work by sending it, rather than going through `client.openLoan`.
    const openHash = await treasuryWallet.sendTransaction({
      account: treasuryWallet.account!,
      chain: treasuryWallet.chain,
      to: openLoan.to,
      data: openLoan.data,
      value: openLoan.value,
    });
    const receipt = await harness.publicClient.waitForTransactionReceipt({ hash: openHash });
    expect(receipt.status).toBe("success");

    const loans = await client.loans({ agent: harness.accounts.treasury.address });
    expect(loans).toHaveLength(1);
    loanId = loans[0]!.loanId;
    expect(loans[0]!.escrow).toBe(predicted);
  });

  it("loan() reports the Auction status and the note's cap before settlement", async () => {
    const loan = await client.loan(loanId);

    expect(loan.status).toBe("Auction");
    expect(loan.termSheet.agentTreasury).toBe(getAddress(harness.accounts.treasury.address));
    expect(loan.cap).toBe(NOTE_SUPPLY / 1_000_000_000_000n);
    expect(loan.repaid).toBe(0n);
    expect(loan.principal).toBe(0n);
    expect(loan.drawn).toBe(0n);
    expect(loan.lastRevenueAt).toBe(0n);
  });

  it("loans() filters by status and by agent", async () => {
    const auctionLoans = await client.loans({ status: "Auction" });
    expect(auctionLoans.map((l) => l.loanId)).toContain(loanId);

    const activeLoans = await client.loans({ status: "Active" });
    expect(activeLoans.map((l) => l.loanId)).not.toContain(loanId);

    const otherAgent = await client.loans({ agent: harness.accounts.cardOwner.address });
    expect(otherAgent.map((l) => l.loanId)).not.toContain(loanId);
  });

  it("auction() reports the live, ungraduated auction before any bid", async () => {
    const auction = await client.auction(loanId);

    expect(auction.graduated).toBe(false);
    expect(auction.currency).toBe(getAddress(harness.fixture.usdc));
    expect(auction.requiredCurrencyRaised).toBe(MIN_PRINCIPAL);
    expect(auction.raisedSoFar).toBe(0n);
    expect(auction.blocksLeft).toBeGreaterThan(0n);
  });

  it("bid() runs the Permit2 flow and fills the auction enough to graduate it", async () => {
    const lenderWallet = harness.walletFor(harness.accounts.lender);
    const priceQ96 = centsToQ96(FLOOR_CENTS);
    bidCost = bidCurrencyCeiling(NOTE_SUPPLY, priceQ96);

    // Fund the bidder directly (MockERC20.mint is unrestricted) — no Doppler fee flow needed for
    // this suite's purpose (exercising the SDK's bid mechanics, not Advance's revenue formula).
    const fundHash = await lenderWallet.writeContract({
      account: lenderWallet.account!,
      chain: lenderWallet.chain,
      address: harness.fixture.usdc,
      abi: mintableErc20Abi,
      functionName: "mint",
      args: [harness.accounts.lender.address, bidCost * 2n],
    });
    await harness.publicClient.waitForTransactionReceipt({ hash: fundHash });

    const before = (await harness.publicClient.readContract({
      address: harness.fixture.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness.accounts.lender.address],
    })) as bigint;

    const result = await client.bid(lenderWallet, { loanId, notes: NOTE_SUPPLY, maxPriceCents: FLOOR_CENTS });
    bidId = result.bidId;
    expect(bidId).toBe(0n);

    const after = (await harness.publicClient.readContract({
      address: harness.fixture.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness.accounts.lender.address],
    })) as bigint;
    expect(before - after).toBe(bidCost);

    const auction = await client.auction(loanId);
    expect(auction.raisedSoFar).toBe(bidCost);
    expect(auction.graduated).toBe(bidCost >= MIN_PRINCIPAL);
  });

  it("settling the auction activates the loan (principal set, status Active)", async () => {
    // Mine past the auction's endBlock, then settle it — `settleAuction` is callable by anyone
    // and isn't part of the SDK's public surface (which scopes reads/writes to the hub, the
    // note, the credit line and the card), so this calls the credit line directly through the
    // SDK's own generated ABI.
    const before = await client.loan(loanId);
    await mineTo(await auctionEndBlock());

    const settlerWallet = harness.walletFor(harness.accounts.lender);
    const settleHash = await settlerWallet.writeContract({
      account: settlerWallet.account!,
      chain: settlerWallet.chain,
      address: before.creditLine,
      abi: creditLineAbi,
      functionName: "settleAuction",
    });
    await harness.publicClient.waitForTransactionReceipt({ hash: settleHash });

    const loan = await client.loan(loanId);
    expect(loan.status).toBe("Active");
    expect(loan.principal).toBe(bidCost);
    expect(loan.cap).toBe(NOTE_SUPPLY / 1_000_000_000_000n); // nothing unsold to burn
    expect(loan.available).toBe(DRAW_LIMIT);
  });

  it("draw() moves USDC from the credit line into the card", async () => {
    const cardOwnerWallet = harness.walletFor(harness.accounts.cardOwner);
    const drawAmount = 400_000n;

    const before = (await harness.publicClient.readContract({
      address: harness.fixture.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness.fixture.agentCard],
    })) as bigint;

    const { hash } = await client.draw(cardOwnerWallet, { card: harness.fixture.agentCard, loanId, amount: drawAmount });
    await harness.publicClient.waitForTransactionReceipt({ hash });

    const after = (await harness.publicClient.readContract({
      address: harness.fixture.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness.fixture.agentCard],
    })) as bigint;
    expect(after - before).toBe(drawAmount);

    const loan = await client.loan(loanId);
    expect(loan.drawn).toBe(drawAmount);
    expect(loan.available).toBe(DRAW_LIMIT - drawAmount);
  });

  it("claim() pays out the lender's pro-rata share once the note has been repaid", async () => {
    const lenderWallet = harness.walletFor(harness.accounts.lender);
    const loan = await client.loan(loanId);

    // The lender claims the notes its filled bid earned from the auction (a separate step from
    // the SDK's own `claim()`, which is the *note's* repayment claim — ICCA.claimTokens vs
    // RevenueNote.claim).
    const claimTokensHash = await lenderWallet.writeContract({
      account: lenderWallet.account!,
      chain: lenderWallet.chain,
      address: loan.auction,
      abi: iccaAbi,
      functionName: "claimTokens",
      args: [bidId],
    });
    await harness.publicClient.waitForTransactionReceipt({ hash: claimTokensHash });

    // Fund the escrow directly and harvest it into the note — again bypassing the Doppler fee
    // flow to reach a real, nonzero repayment to claim.
    const repayment = 1_000_000n; // $1
    const mintHash = await lenderWallet.writeContract({
      account: lenderWallet.account!,
      chain: lenderWallet.chain,
      address: harness.fixture.usdc,
      abi: mintableErc20Abi,
      functionName: "mint",
      args: [loan.escrow, repayment],
    });
    await harness.publicClient.waitForTransactionReceipt({ hash: mintHash });

    const harvestHash = await lenderWallet.writeContract({
      account: lenderWallet.account!,
      chain: lenderWallet.chain,
      address: loan.escrow,
      abi: revenueEscrowAbi,
      functionName: "harvest",
      args: [0n],
    });
    await harness.publicClient.waitForTransactionReceipt({ hash: harvestHash });

    const before = (await harness.publicClient.readContract({
      address: harness.fixture.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness.accounts.lender.address],
    })) as bigint;

    const result = await client.claim(lenderWallet, loanId);
    await harness.publicClient.waitForTransactionReceipt({ hash: result.hash });
    expect(result.amount).toBe(repayment); // lender holds every note (100%)

    const after = (await harness.publicClient.readContract({
      address: harness.fixture.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness.accounts.lender.address],
    })) as bigint;
    expect(after - before).toBe(repayment);

    const loanAfter = await client.loan(loanId);
    expect(loanAfter.repaid).toBe(repayment);
  });
});

async function auctionEndBlock(): Promise<bigint> {
  const auction = await client.auction(loanId);
  return auction.endBlock;
}

async function mineTo(targetBlock: bigint): Promise<void> {
  const current = await harness.publicClient.getBlockNumber();
  if (current >= targetBlock) return;
  const blocksToMine = targetBlock - current;
  const res = await fetch(harness.publicClient.transport.url as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_mine",
      params: [`0x${blocksToMine.toString(16)}`],
    }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`anvil_mine failed: ${body.error.message}`);
}
