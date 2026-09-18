import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializable,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  advanceHubAbi,
  agentCardAbi,
  ccaAbi,
  creditLineAbi,
  feesManagerAbi,
  identityRegistryAbi,
  revenueNoteAbi,
  signTermSheet,
  type TermSheet,
} from "@advance/core";
import {
  bidOnNote,
  claim,
  drawCredit,
  harvest,
  markDefault,
  moveBeneficiary,
  openLoan,
  predictEscrow,
  registerAgent,
  settleAuction,
  type ActionContext,
} from "../../src/chain/actions.js";
import type { ActionKeys } from "../../src/chain/clients.js";
import { EventStore } from "../../src/events.js";
import { FileStore } from "../../src/store.js";
import { BASE_MAINNET, deployHubOnFork, loadArtifact, type HubFork } from "../helpers/hub-fork.js";

// This suite forks live Base mainnet and shells out to `forge script`, so it only runs with
// BASE_RPC_URL set (see internal/.env, never printed/committed) - unset, it self-skips like every
// other fork suite in this repo.
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const describeIfFork = BASE_RPC_URL ? describe : describe.skip;

const TICK_SPACING_Q96 = (10_000n << 96n) / 10n ** 18n;
const FLOOR_CENTS = 80;
const FLOOR_Q96 = TICK_SPACING_Q96 * BigInt(FLOOR_CENTS);
const PRICE_100 = TICK_SPACING_Q96 * 100n;
const PRICE_90 = TICK_SPACING_Q96 * 90n;

const NOTE_SUPPLY = 5_000_000_000_000_000_000n; // 5e18 -> cap 5 USDC at par
const MIN_PRINCIPAL = 2_000_000n; // 2 USDC
const AUCTION_BLOCKS = 100n;
const DRAW_LIMIT = 2_500_000n;
const DRAW_PERIOD = 86_400n;
const GRACE_PERIOD = 60n; // short, so the fork test can warp past it quickly
const BID_A_AMOUNT = 2_000_000n; // matches the undersubscribed-at-floor CCA fork spike exactly
const BID_B_AMOUNT = 1_200_000n;
const DRAW_AMOUNT = 2_000_000n;
const DRAW_AMOUNT_LOAN_2 = 1_000_000n; // leaves the rest of loan 2's principal in the credit line for `freeze` to distribute

/** Every signing role this test drives an action from, backed by a fresh local key (never an
 * anvil default account, per this repo's own fork-test convention). */
interface Actors {
  underwriter: PrivateKeyAccount;
  owner: PrivateKeyAccount;
  deployer: PrivateKeyAccount;
  treasury: PrivateKeyAccount;
  cardOwner: PrivateKeyAccount;
  lenderA: PrivateKeyAccount;
  lenderB: PrivateKeyAccount;
  keeper: PrivateKeyAccount;
}

/** Raw private keys are never a `PrivateKeyAccount` property (viem deliberately does not expose
 * one), so this test keeps them alongside the derived accounts for the two spots that need a raw
 * key directly: `forge script --private-key` and `@advance/core`'s `signTermSheet`. */
const privateKeys = new WeakMap<PrivateKeyAccount, Hex>();

function makeActor(): PrivateKeyAccount {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  privateKeys.set(account, privateKey);
  return account;
}

function privateKeyOf(account: PrivateKeyAccount): Hex {
  const privateKey = privateKeys.get(account);
  if (!privateKey) throw new Error("privateKeyOf: unknown account");
  return privateKey;
}

function freshActors(): Actors {
  return {
    underwriter: makeActor(),
    owner: makeActor(),
    deployer: makeActor(),
    treasury: makeActor(),
    cardOwner: makeActor(),
    lenderA: makeActor(),
    lenderB: makeActor(),
    keeper: makeActor(),
  };
}

/** {@link ActionKeys} backed by a plain in-memory map of local viem accounts, standing in for a
 * real `DynamicKeys` instance - same substitution the card gateway fork test uses
 * (`fakeKeysFor`), generalized to many labels sharing one context. */
function actionKeysFor(accounts: Record<string, PrivateKeyAccount>): ActionKeys {
  return {
    async address(label: string) {
      const account = accounts[label];
      if (!account) throw new Error(`actionKeysFor: no account for label "${label}"`);
      return account.address;
    },
    async signTransaction(label: string, transaction: TransactionSerializable) {
      const account = accounts[label];
      if (!account) throw new Error(`actionKeysFor: no account for label "${label}"`);
      return account.signTransaction(transaction);
    },
  };
}

describeIfFork("chain/actions (anvil fork of Base mainnet + forge-deployed AdvanceHub)", () => {
  let hubFork: HubFork;
  let publicClient: PublicClient;
  let actors: Actors;
  let ctx: ActionContext;
  let card: Address;
  let eventsDir: string;
  let events: EventStore;

  let agentId: bigint;
  let termSheet: TermSheet;
  let escrow: Address;
  let loanId: bigint;
  let note: Address;
  let creditLine: Address;
  let auction: Address;
  let bidIdA: bigint;
  let bidIdB: bigint;
  let principal: bigint;
  let capUsdc: bigint;
  let escrowSharesAfterMove: bigint;
  let cardUsdcAfterDraw1: bigint;

  let termSheet2: TermSheet;
  let escrow2: Address;
  let loanId2: bigint;
  let note2: Address;
  let creditLine2: Address;
  let auction2: Address;
  let bidIdA2: bigint;
  let bidIdB2: bigint;
  let escrow2SharesAfterMove: bigint;

  function rpc(method: string, params: unknown[]): Promise<unknown> {
    return (publicClient as unknown as { request(a: { method: string; params: unknown[] }): Promise<unknown> }).request({
      method,
      params,
    });
  }

  /** Test scaffolding only, never `chain/actions.ts`: impersonates `from` (an address this test
   * has no private key for) and sends one unsigned transaction as it. Used once, to hand the real
   * Ratspeak pool's beneficiary role from its real creator to a treasury key this test controls -
   * after that, every step runs through the real signed actions under test. */
  async function impersonatedSend(from: Address, to: Address, data: Hex): Promise<void> {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, toHex(10n ** 18n)]);
    const hash = (await rpc("eth_sendTransaction", [{ from, to, data }])) as Hex;
    await publicClient.waitForTransactionReceipt({ hash });
    await rpc("anvil_stopImpersonatingAccount", [from]);
  }

  /** Test scaffolding only: a plain viem wallet client for `account`, used for the handful of
   * on-chain steps outside `chain/actions.ts`'s scope (deploying the AgentCard; a lender
   * exiting/claiming its CCA-won notes, which the brief's action set does not wrap). */
  function rawWalletClient(account: PrivateKeyAccount) {
    return createWalletClient({ account, chain: base, transport: http(hubFork.fork.rpcUrl) });
  }

  beforeAll(async () => {
    actors = freshActors();

    hubFork = await deployHubOnFork({
      forkUrl: BASE_RPC_URL!,
      port: 8559,
      underwriter: actors.underwriter.address,
      owner: actors.owner.address,
      deployerPrivateKey: privateKeyOf(actors.deployer),
      deployerAddress: actors.deployer.address,
    });
    publicClient = hubFork.publicClient;

    // Fund every signing role with ETH for gas, and the lenders with real USDC (anvil storage
    // cheat, same helper the card gateway fork test uses).
    for (const account of Object.values(actors)) {
      await hubFork.fork.setBalance(account.address, 10n ** 18n);
    }
    await hubFork.fork.setUsdcBalance(BASE_MAINNET.usdc, actors.lenderA.address, 10_000_000n);
    await hubFork.fork.setUsdcBalance(BASE_MAINNET.usdc, actors.lenderB.address, 10_000_000n);

    // Deploy the AgentCard the loan will bind to - not one of this task's actions (a one-time
    // setup deploy, same as the card gateway fork test does directly via viem).
    const cardArtifact = loadArtifact("AgentCard");
    const cardDeployHash = await rawWalletClient(actors.deployer).deployContract({
      abi: cardArtifact.abi,
      bytecode: cardArtifact.bytecode.object,
      args: [actors.cardOwner.address, hubFork.hub, BASE_MAINNET.usdc, 5_000_000n, 3600n, [actors.treasury.address]],
    });
    const cardReceipt = await publicClient.waitForTransactionReceipt({ hash: cardDeployHash });
    card = cardReceipt.contractAddress!;

    eventsDir = mkdtempSync(join(tmpdir(), "agent-kit-actions-fork-"));
    events = new EventStore(new FileStore(eventsDir));

    ctx = {
      chain: base,
      transport: http(hubFork.fork.rpcUrl),
      publicClient,
      keys: actionKeysFor({
        treasury: actors.treasury,
        cardOwner: actors.cardOwner,
        lenderA: actors.lenderA,
        lenderB: actors.lenderB,
        keeper: actors.keeper,
      }),
      addresses: {
        hub: hubFork.hub,
        usdc: BASE_MAINNET.usdc,
        permit2: BASE_MAINNET.permit2,
        identityRegistry: BASE_MAINNET.identityRegistry,
      },
      events,
    };

    // 1. register: the treasury registers as an ERC-8004 agent.
    const registered = await registerAgent(ctx, { label: "treasury", agentURI: "https://example.com/advance-fork-test.json" });
    agentId = registered.agentId;

    // Bootstrap only (not chain/actions.ts under test): hand the real Ratspeak pool's beneficiary
    // shares from its real creator to our treasury key, since this test holds no private key for
    // the real creator. Everything from here on runs through the real, signed actions.
    const realShares = (await publicClient.readContract({
      address: BASE_MAINNET.ratspeakPool.feesManager,
      abi: feesManagerAbi,
      functionName: "getShares",
      args: [BASE_MAINNET.ratspeakPool.poolId, BASE_MAINNET.ratspeakPool.realCreator],
    })) as bigint;
    expect(realShares).toBeGreaterThan(0n);
    await impersonatedSend(
      BASE_MAINNET.ratspeakPool.realCreator,
      BASE_MAINNET.ratspeakPool.feesManager,
      encodeFunctionData({
        abi: feesManagerAbi,
        functionName: "updateBeneficiary",
        args: [BASE_MAINNET.ratspeakPool.poolId, actors.treasury.address],
      }),
    );
    const treasuryShares = (await publicClient.readContract({
      address: BASE_MAINNET.ratspeakPool.feesManager,
      abi: feesManagerAbi,
      functionName: "getShares",
      args: [BASE_MAINNET.ratspeakPool.poolId, actors.treasury.address],
    })) as bigint;
    expect(treasuryShares).toEqual(realShares);

    const block = await publicClient.getBlock();
    termSheet = {
      agentTreasury: actors.treasury.address,
      agentCard: card,
      agentId,
      feesManager: BASE_MAINNET.ratspeakPool.feesManager,
      poolId: BASE_MAINNET.ratspeakPool.poolId,
      expectedShares: treasuryShares,
      noteSupply: NOTE_SUPPLY,
      floorCents: FLOOR_CENTS,
      minPrincipal: MIN_PRINCIPAL,
      auctionBlocks: AUCTION_BLOCKS,
      drawLimit: DRAW_LIMIT,
      drawPeriod: DRAW_PERIOD,
      gracePeriod: GRACE_PERIOD,
      deadline: block.timestamp + 3600n,
      nonce: 1n,
      memoHash: keccak256(toBytes("advance-fork-test")),
    };
    const signature = await signTermSheet(termSheet, hubFork.fork.chainId, hubFork.hub, privateKeyOf(actors.underwriter));

    // 2. predictEscrow + moveBeneficiary: point the treasury's shares at the loan's escrow.
    escrow = await predictEscrow(ctx, { termSheet });
    await moveBeneficiary(ctx, { label: "treasury", feesManager: termSheet.feesManager, poolId: termSheet.poolId, to: escrow });
    // Snapshotted here, not re-read later: loan 1 fully repays before any `it` runs (see step 8
    // below), and repayment hands the escrow's shares straight back to the treasury.
    escrowSharesAfterMove = (await publicClient.readContract({
      address: BASE_MAINNET.ratspeakPool.feesManager,
      abi: feesManagerAbi,
      functionName: "getShares",
      args: [BASE_MAINNET.ratspeakPool.poolId, escrow],
    })) as bigint;

    // 3. openLoan.
    const opened = await openLoan(ctx, { label: "treasury", termSheet, signature });
    loanId = opened.loanId;

    const loan = (await publicClient.readContract({
      address: hubFork.hub,
      abi: advanceHubAbi,
      functionName: "loan",
      args: [loanId],
    })) as { escrow: Address; note: Address; creditLine: Address; auction: Address; status: number };
    note = loan.note;
    creditLine = loan.creditLine;
    auction = loan.auction;
    expect(loan.escrow.toLowerCase()).toEqual(escrow.toLowerCase());

    // 4. two lender bids (undersubscribed at the floor, so both fill in full via plain exitBid).
    bidIdA = (await bidOnNote(ctx, { label: "lenderA", auction, maxPriceQ96: PRICE_100, amount: BID_A_AMOUNT, prevTickPriceQ96: FLOOR_Q96 })).bidId;
    bidIdB = (await bidOnNote(ctx, { label: "lenderB", auction, maxPriceQ96: PRICE_90, amount: BID_B_AMOUNT, prevTickPriceQ96: FLOOR_Q96 })).bidId;

    // 5. roll blocks to the auction's end.
    const endBlock = (await publicClient.readContract({ address: auction, abi: ccaAbi, functionName: "endBlock" })) as bigint;
    const currentBlock = await publicClient.getBlockNumber();
    if (endBlock > currentBlock) {
      await rpc("anvil_mine", [toHex(endBlock - currentBlock)]);
    }

    // 6. settle.
    await settleAuction(ctx, { label: "keeper", creditLine });
    principal = (await publicClient.readContract({ address: creditLine, abi: creditLineAbi, functionName: "principal" })) as bigint;
    capUsdc = (await publicClient.readContract({ address: note, abi: revenueNoteAbi, functionName: "capUsdc" })) as bigint;

    // 7. drawCredit.
    await drawCredit(ctx, { ownerLabel: "cardOwner", card, creditLine, amount: DRAW_AMOUNT });
    // Snapshotted here, not re-read later: loan 2 draws into the same card, and its own
    // `markDefault` sweeps the card's whole (by-then cumulative) USDC balance back out.
    cardUsdcAfterDraw1 = (await publicClient.readContract({ address: BASE_MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [card] })) as bigint;

    // 8. harvest: real Doppler fee collection (the Ratspeak pool has substantial real, never-
    // collected trading fees - this is not a synthetic donation), a real Chainlink-bounded Uniswap
    // swap of the WETH leg, and real note distribution. Against this real pool it fills the note's
    // whole (small, $4) cap in one call, closing the loan on the spot: the hub hands the escrow's
    // shares back to the treasury, unfreezes the card hook, and posts +100 ERC-8004 feedback.
    await harvest(ctx, { label: "keeper", escrow, minUsdcOut: 0n });

    // Scaffolding: lenders exit and claim the notes their loan-1 bids won from the CCA auction
    // itself (`ICCA.exitBid`/`claimTokens` - a lender's direct interaction with the third-party
    // auction contract, not part of this task's action set) so they actually hold notes to claim
    // repayment against.
    for (const [account, bidId] of [
      [actors.lenderA, bidIdA],
      [actors.lenderB, bidIdB],
    ] as const) {
      const wc = rawWalletClient(account);
      const exitHash = await wc.writeContract({ address: auction, abi: ccaAbi, functionName: "exitBid", args: [bidId], chain: base, account });
      await publicClient.waitForTransactionReceipt({ hash: exitHash });
      const claimTokensHash = await wc.writeContract({ address: auction, abi: ccaAbi, functionName: "claimTokens", args: [bidId], chain: base, account });
      await publicClient.waitForTransactionReceipt({ hash: claimTokensHash });
    }

    // --- loan 2: markDefault + claim, on a second loan against the same real pool -------------
    // Loan 1 closed Repaid, which frees both the card (`liveLoanOf` cleared) and the treasury's
    // fee shares (handed back by `_returnBeneficiary`), so a second loan can reuse both for real,
    // exactly as a repeat borrower would. This loan is deliberately never harvested, so the only
    // repayment its noteholders ever see comes from `CreditLine.freeze()` inside `markDefault`
    // itself - proving that action, and `claim`, without depending on how much real fee windfall a
    // pool happens to have (loan 1 already proved the harvest/swap path).
    const block2 = await publicClient.getBlock();
    termSheet2 = {
      ...termSheet,
      expectedShares: (await publicClient.readContract({
        address: BASE_MAINNET.ratspeakPool.feesManager,
        abi: feesManagerAbi,
        functionName: "getShares",
        args: [BASE_MAINNET.ratspeakPool.poolId, actors.treasury.address],
      })) as bigint,
      deadline: block2.timestamp + 3600n,
      nonce: 2n,
      memoHash: keccak256(toBytes("advance-fork-test-loan-2")),
    };
    const signature2 = await signTermSheet(termSheet2, hubFork.fork.chainId, hubFork.hub, privateKeyOf(actors.underwriter));

    escrow2 = await predictEscrow(ctx, { termSheet: termSheet2 });
    await moveBeneficiary(ctx, { label: "treasury", feesManager: termSheet2.feesManager, poolId: termSheet2.poolId, to: escrow2 });
    // Snapshotted here, not re-read later: loan 2's own `markDefault` ends up repaying it too
    // (see below), which likewise hands escrow2's shares back to the treasury.
    escrow2SharesAfterMove = (await publicClient.readContract({
      address: BASE_MAINNET.ratspeakPool.feesManager,
      abi: feesManagerAbi,
      functionName: "getShares",
      args: [BASE_MAINNET.ratspeakPool.poolId, escrow2],
    })) as bigint;
    const opened2 = await openLoan(ctx, { label: "treasury", termSheet: termSheet2, signature: signature2 });
    loanId2 = opened2.loanId;

    const loan2 = (await publicClient.readContract({
      address: hubFork.hub,
      abi: advanceHubAbi,
      functionName: "loan",
      args: [loanId2],
    })) as { note: Address; creditLine: Address; auction: Address };
    note2 = loan2.note;
    creditLine2 = loan2.creditLine;
    auction2 = loan2.auction;

    bidIdA2 = (await bidOnNote(ctx, { label: "lenderA", auction: auction2, maxPriceQ96: PRICE_100, amount: BID_A_AMOUNT, prevTickPriceQ96: FLOOR_Q96 })).bidId;
    bidIdB2 = (await bidOnNote(ctx, { label: "lenderB", auction: auction2, maxPriceQ96: PRICE_90, amount: BID_B_AMOUNT, prevTickPriceQ96: FLOOR_Q96 })).bidId;

    const endBlock2 = (await publicClient.readContract({ address: auction2, abi: ccaAbi, functionName: "endBlock" })) as bigint;
    const currentBlock2 = await publicClient.getBlockNumber();
    if (endBlock2 > currentBlock2) {
      await rpc("anvil_mine", [toHex(endBlock2 - currentBlock2)]);
    }
    await settleAuction(ctx, { label: "keeper", creditLine: creditLine2 });

    // Draw only part of the principal, leaving the rest in the credit line for `freeze` (inside
    // `markDefault`) to distribute to the note.
    await drawCredit(ctx, { ownerLabel: "cardOwner", card, creditLine: creditLine2, amount: DRAW_AMOUNT_LOAN_2 });

    await rpc("evm_increaseTime", [Number(GRACE_PERIOD) + 5]);
    await rpc("anvil_mine", ["0x1"]);
    await markDefault(ctx, { label: "keeper", loanId: loanId2 });

    for (const [account, bidId] of [
      [actors.lenderA, bidIdA2],
      [actors.lenderB, bidIdB2],
    ] as const) {
      const wc = rawWalletClient(account);
      const exitHash = await wc.writeContract({ address: auction2, abi: ccaAbi, functionName: "exitBid", args: [bidId], chain: base, account });
      await publicClient.waitForTransactionReceipt({ hash: exitHash });
      const claimTokensHash = await wc.writeContract({ address: auction2, abi: ccaAbi, functionName: "claimTokens", args: [bidId], chain: base, account });
      await publicClient.waitForTransactionReceipt({ hash: claimTokensHash });
    }
  }, 240_000);

  afterAll(async () => {
    await hubFork?.fork?.stop();
    if (eventsDir) rmSync(eventsDir, { recursive: true, force: true });
  });

  it("registers a real ERC-8004 agent id owned by the treasury", async () => {
    expect(agentId).toBeGreaterThan(0n);
    const registryOwner = (await publicClient.readContract({
      address: BASE_MAINNET.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    })) as Address;
    expect(registryOwner.toLowerCase()).toEqual(actors.treasury.address.toLowerCase());
  });

  it("moves the real pool's fee beneficiary shares onto the predicted escrow before opening the loan", () => {
    expect(escrowSharesAfterMove).toEqual(termSheet.expectedShares);
  });

  it("opens the loan with a real CCA auction wired to the credit line", async () => {
    expect(loanId).toBeGreaterThan(0n);
    // beforeAll drives the whole lifecycle before any `it` runs, so by now the loan has already
    // progressed past Auction (see the "harvests..." test below for its final Repaid status) -
    // this checks `openLoan`'s own auction wiring, captured from the `LoanOpened`-driven read.
    const fundsRecipient = (await publicClient.readContract({ address: auction, abi: ccaAbi, functionName: "fundsRecipient" })) as Address;
    expect(fundsRecipient.toLowerCase()).toEqual(creditLine.toLowerCase());
    const tokensRecipient = (await publicClient.readContract({ address: auction, abi: ccaAbi, functionName: "tokensRecipient" })) as Address;
    expect(tokensRecipient.toLowerCase()).toEqual(creditLine.toLowerCase());
  });

  it("settles the auction with both bids filled and a real USDC principal swept to the credit line", async () => {
    expect(principal).toBeGreaterThan(0n);
    expect(principal).toBeGreaterThanOrEqual(MIN_PRINCIPAL);
    expect(capUsdc).toBeGreaterThan(0n);
    const auctionUsdc = (await publicClient.readContract({
      address: BASE_MAINNET.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [auction],
    })) as bigint;
    expect(auctionUsdc).toBeLessThan(1000n); // swept, only rounding dust may remain
  });

  it("draws USDC from the credit line into the card", () => {
    expect(cardUsdcAfterDraw1).toEqual(DRAW_AMOUNT);
  });

  it("harvests real swept fees, swapped through the real Uniswap router, filling the note's cap and closing the loan", async () => {
    const remainingCap = (await publicClient.readContract({ address: note, abi: revenueNoteAbi, functionName: "remainingCap" })) as bigint;
    const totalRepaid = (await publicClient.readContract({ address: note, abi: revenueNoteAbi, functionName: "totalRepaid" })) as bigint;
    expect(totalRepaid).toBeGreaterThan(0n);
    expect(remainingCap).toEqual(0n);
    expect(totalRepaid).toEqual(capUsdc);

    const loan = (await publicClient.readContract({
      address: hubFork.hub,
      abi: advanceHubAbi,
      functionName: "loan",
      args: [loanId],
    })) as { status: number };
    expect(loan.status).toEqual(3); // Repaid

    // The escrow's shares moved back to the treasury and the card's `liveLoanOf` binding cleared,
    // both driven by the hub's own `onRepaid` callback off the real harvest call above.
    const treasuryShares = (await publicClient.readContract({
      address: BASE_MAINNET.ratspeakPool.feesManager,
      abi: feesManagerAbi,
      functionName: "getShares",
      args: [BASE_MAINNET.ratspeakPool.poolId, actors.treasury.address],
    })) as bigint;
    expect(treasuryShares).toEqual(termSheet.expectedShares);
  });

  it("posts real +100 ERC-8004 reputation feedback for the repaid loan", async () => {
    const summary = (await publicClient.readContract({
      address: BASE_MAINNET.reputationRegistry,
      abi: [
        {
          type: "function",
          name: "getSummary",
          stateMutability: "view",
          inputs: [
            { name: "agentId", type: "uint256" },
            { name: "clientAddresses", type: "address[]" },
            { name: "tag1", type: "string" },
            { name: "tag2", type: "string" },
          ],
          outputs: [
            { name: "count", type: "uint64" },
            { name: "summaryValue", type: "int128" },
            { name: "summaryValueDecimals", type: "uint8" },
          ],
        },
      ] as const,
      functionName: "getSummary",
      // The hub posts feedback with tag1="advance", tag2=outcome (see `AdvanceHub._postFeedback`).
      args: [agentId, [hubFork.hub], "advance", "repaid"],
    })) as readonly [bigint, bigint, number];
    expect(summary[0]).toBeGreaterThanOrEqual(1n);
    expect(summary[1]).toEqual(100n);
  });

  it("opens a second loan reusing the same card and treasury shares once the first is repaid", () => {
    expect(loanId2).toBeGreaterThan(loanId);
    expect(escrow2SharesAfterMove).toEqual(termSheet2.expectedShares);
  });

  it("marks the second loan defaulted, freezing the card and credit line before the card's returned balance repays it in full", async () => {
    // `markDefault` freezes the card, then sweeps its whole USDC balance (both loans' draws,
    // since they share one card) into credit line 2, then freezes the credit line: that sweep
    // covers credit line 2's entire remaining cap, so `freeze`'s distribution fills the note and
    // `closeIfRepaid` closes it in the same call - the documented "a card hook repays the loan
    // mid-default" path (see `AdvanceHub.markDefault`'s NatSpec), which still exercises the real
    // freeze, returnFunds, reputation and close logic under test.
    const loan2 = (await publicClient.readContract({
      address: hubFork.hub,
      abi: advanceHubAbi,
      functionName: "loan",
      args: [loanId2],
    })) as { status: number };
    expect(loan2.status).toEqual(3); // Repaid (via the default path)
    const frozen = (await publicClient.readContract({ address: card, abi: agentCardAbi, functionName: "frozen" })) as boolean;
    expect(frozen).toBe(false); // onRepaid unfroze it again
    const creditLineState = (await publicClient.readContract({ address: creditLine2, abi: creditLineAbi, functionName: "state" })) as number;
    expect(creditLineState).toEqual(2); // Frozen is terminal - stays Frozen even once the loan is Repaid
    const remainingCap2 = (await publicClient.readContract({ address: note2, abi: revenueNoteAbi, functionName: "remainingCap" })) as bigint;
    expect(remainingCap2).toEqual(0n);
  });

  it("pays the second loan's noteholders their pro-rata claim, including a claimFor called by someone else", async () => {
    const beforeA = (await publicClient.readContract({ address: BASE_MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [actors.lenderA.address] })) as bigint;
    const beforeB = (await publicClient.readContract({ address: BASE_MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [actors.lenderB.address] })) as bigint;

    await claim(ctx, { label: "lenderA", note: note2 });
    // lenderB never signs anything here - "keeper" pays gas and claimFor pays lenderB directly.
    await claim(ctx, { label: "keeper", note: note2, holder: actors.lenderB.address });

    const afterA = (await publicClient.readContract({ address: BASE_MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [actors.lenderA.address] })) as bigint;
    const afterB = (await publicClient.readContract({ address: BASE_MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [actors.lenderB.address] })) as bigint;

    expect(afterA).toBeGreaterThan(beforeA);
    expect(afterB).toBeGreaterThan(beforeB);
  });

  it("logs an event for every action taken", async () => {
    const all = await events.list();
    const kinds = new Set(all.map((e) => e.kind));
    for (const kind of ["registerAgent", "moveBeneficiary", "openLoan", "bidOnNote", "settleAuction", "drawCredit", "harvest", "markDefault", "claim"]) {
      expect(kinds.has(kind), `missing event kind "${kind}"`).toBe(true);
    }
    expect(all.every((e) => e.txHash !== undefined)).toBe(true);
  });
});
