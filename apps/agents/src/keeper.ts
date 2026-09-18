import {
  advanceHubAbi,
  ccaAbi,
  creditLineAbi,
  feesManagerAbi,
  revenueEscrowAbi,
  revenueNoteAbi,
  type TermSheet,
} from "@advance/core";
import {
  harvest as harvestAction,
  markDefault as markDefaultAction,
  settleAuction as settleAuctionAction,
  type ActionContext,
} from "@advance/agent-kit";
import type { EventSink } from "@advance/agent-kit";
import { erc20Abi, type Address, type Hex, type PublicClient } from "viem";

/** Default harvest floor: 0.0005 WETH - the same figure plan-03 gives for "pending WETH worth
 * bothering with", tuned so the keeper doesn't spend gas harvesting dust. */
export const DEFAULT_HARVEST_MIN_WETH = 500_000_000_000_000n;

// Mirrors `IAdvance.LoanStatus`/`CreditLine.State`/`RevenueEscrow.Phase` (see
// contracts/src/interfaces/IAdvance.sol, CreditLine.sol, RevenueEscrow.sol) - plain numbers, since
// that's what viem decodes a Solidity `enum` return into.
const LoanStatus = { None: 0, Auction: 1, Active: 2, Repaid: 3, Defaulted: 4, Failed: 5, Aborted: 6 } as const;
const CreditLineState = { Pending: 0, Active: 1, Frozen: 2, Closed: 3, Failed: 4 } as const;
const EscrowPhase = { Pending: 0, Active: 1, Closed: 2 } as const;

/** Everything `decideForLoan` needs about one loan, already read off-chain - kept flat and
 * primitive so the decision itself never touches a `PublicClient`. */
export interface LoanSnapshot {
  loanId: bigint;
  /** `IAdvance.LoanStatus` */
  status: number;
  creditLine: Address;
  /** `CreditLine.State` */
  creditLineState: number;
  auction: Address;
  auctionEndBlock: bigint;
  escrow: Address;
  /** `RevenueEscrow.Phase` */
  escrowPhase: number;
  lastRevenueAt: bigint;
  gracePeriod: bigint;
  /** Escrow's current WETH balance plus a simulated `collectFees` pending amount (WETH leg only). */
  pendingHarvestWeth: bigint;
  /** `RevenueNote.remainingCap()`, USDC-wei. */
  noteRemainingCap: bigint;
  /** Escrow's current USDC balance, USDC-wei. */
  escrowUsdcBalance: bigint;
}

export interface KeeperNow {
  blockNumber: bigint;
  timestamp: bigint;
}

export interface KeeperConfig {
  harvestMinWeth: bigint;
}

export type KeeperDecision =
  | { action: "none" }
  | { action: "settleAuction"; creditLine: Address }
  | { action: "harvest"; escrow: Address }
  | { action: "markDefault"; loanId: bigint };

/**
 * Pure per-loan policy: settle an ended auction, harvest a loan with enough pending revenue (or
 * whose note cap is already reachable from what's sitting in the escrow), or mark a delinquent
 * loan defaulted. Never mutates its inputs, never touches the network - every fact it needs is
 * already in `snapshot`/`now`. Re-run every tick against fresh state, so each branch is naturally
 * idempotent: once a decision's own precondition (credit line state, escrow phase, loan status)
 * flips on-chain, the same loan stops matching that branch.
 */
export function decideForLoan(snapshot: LoanSnapshot, now: KeeperNow, config: KeeperConfig): KeeperDecision {
  if (snapshot.status === LoanStatus.Auction) {
    if (snapshot.creditLineState === CreditLineState.Pending && now.blockNumber >= snapshot.auctionEndBlock) {
      return { action: "settleAuction", creditLine: snapshot.creditLine };
    }
    return { action: "none" };
  }

  // A defaulted loan can still repay late (see IAdvance.LoanStatus's Defaulted -> Repaid note), so
  // harvesting stays live for it; only a still-Active loan can newly default.
  if (snapshot.status === LoanStatus.Active || snapshot.status === LoanStatus.Defaulted) {
    if (snapshot.escrowPhase === EscrowPhase.Active) {
      const capReachable = snapshot.noteRemainingCap <= snapshot.escrowUsdcBalance;
      if (snapshot.pendingHarvestWeth >= config.harvestMinWeth || capReachable) {
        return { action: "harvest", escrow: snapshot.escrow };
      }
    }
    if (snapshot.status === LoanStatus.Active) {
      const eligibleAt = snapshot.lastRevenueAt + snapshot.gracePeriod;
      if (now.timestamp > eligibleAt) {
        return { action: "markDefault", loanId: snapshot.loanId };
      }
    }
  }

  return { action: "none" };
}

/** Read-only view of the loan book a keeper tick needs. Production reads it off-chain (see
 * {@link createLiveKeeperChainReader}); tests supply fixed fixtures. */
export interface KeeperChainReader {
  loanCount(): Promise<bigint>;
  loanSnapshot(loanId: bigint): Promise<LoanSnapshot>;
  now(): Promise<KeeperNow>;
}

/** The three state-changing calls a keeper tick can make, already bound to a paying key. Kept
 * separate from `@advance/agent-kit`'s `settleAuction`/`harvest`/`markDefault` (which need a full
 * `ActionContext`) so `tick` itself never touches viem - see {@link createLiveKeeperActions} for
 * the real wiring. */
export interface KeeperActions {
  settleAuction(creditLine: Address): Promise<Hex>;
  harvest(escrow: Address): Promise<Hex>;
  markDefault(loanId: bigint): Promise<Hex>;
}

export interface KeeperTickParams {
  reader: KeeperChainReader;
  actions: KeeperActions;
  /** Refusals/errors are logged here - the three actions themselves already log their own
   * success events (see `chain/actions.ts`), so `tick` never duplicates those. */
  events: EventSink;
  /** Event `agent` label for anything `tick` itself logs (e.g. `"keeper"`). */
  agent: string;
  config?: Partial<KeeperConfig>;
}

export interface KeeperTickResult {
  checked: number;
  actionsTaken: Array<{ loanId: bigint; action: KeeperDecision["action"]; hash: Hex }>;
  errors: Array<{ loanId?: bigint; message: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One keeper pass over the whole loan book: enumerate every loan (`hub.loanCount`/`hub.loan`),
 * decide and act on each independently, and never let one loan's failure (a bad read, a reverted
 * tx) stop the rest of the book from being checked - errors are caught, logged as `keeper_error`
 * events, and collected in the result instead of thrown. Permissionless by design: nothing here
 * assumes `actions` is called by any particular address, only that it pays gas.
 */
export async function tick(params: KeeperTickParams): Promise<KeeperTickResult> {
  const { reader, actions, events, agent } = params;
  const config: KeeperConfig = { harvestMinWeth: params.config?.harvestMinWeth ?? DEFAULT_HARVEST_MIN_WETH };
  const result: KeeperTickResult = { checked: 0, actionsTaken: [], errors: [] };

  let loanCount: bigint;
  let now: KeeperNow;
  try {
    [loanCount, now] = await Promise.all([reader.loanCount(), reader.now()]);
  } catch (err) {
    const message = errorMessage(err);
    result.errors.push({ message });
    await events.append({ agent, kind: "keeper_error", data: { stage: "enumerate", message } });
    return result;
  }

  for (let loanId = 1n; loanId <= loanCount; loanId++) {
    result.checked++;
    try {
      const snapshot = await reader.loanSnapshot(loanId);
      const decision = decideForLoan(snapshot, now, config);
      if (decision.action === "none") continue;

      const hash =
        decision.action === "settleAuction"
          ? await actions.settleAuction(decision.creditLine)
          : decision.action === "harvest"
            ? await actions.harvest(decision.escrow)
            : await actions.markDefault(decision.loanId);

      result.actionsTaken.push({ loanId, action: decision.action, hash });
    } catch (err) {
      const message = errorMessage(err);
      result.errors.push({ loanId, message });
      await events.append({ agent, kind: "keeper_error", data: { loanId: loanId.toString(), message } });
    }
  }

  return result;
}

/** Binds `@advance/agent-kit`'s permissionless actions to `label`'s paying key - the real
 * production {@link KeeperActions}. */
export function createLiveKeeperActions(ctx: ActionContext, label: string): KeeperActions {
  return {
    async settleAuction(creditLine) {
      const { hash } = await settleAuctionAction(ctx, { label, creditLine });
      return hash;
    },
    async harvest(escrow) {
      const { hash } = await harvestAction(ctx, { label, escrow, minUsdcOut: 0n });
      return hash;
    },
    async markDefault(loanId) {
      const { hash } = await markDefaultAction(ctx, { label, loanId });
      return hash;
    },
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Simulates `feesManager.collectFees(poolId)` as the escrow would call it (an `eth_call`, never
 * broadcast) to estimate the WETH-leg fee a real `harvest()` would pull in right now, added to
 * what the escrow already holds. Never throws: a pool not yet eligible for collection (see
 * `WrongPoolStatus`) or any other simulate failure is treated as "nothing pending" - the next
 * tick tries again. */
async function pendingHarvestWeth(params: {
  publicClient: PublicClient;
  feesManager: Address;
  poolId: Hex;
  escrow: Address;
  weth: Address;
}): Promise<bigint> {
  const { publicClient, feesManager, poolId, escrow, weth } = params;
  const wethBalance = (await publicClient.readContract({
    address: weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [escrow],
  })) as bigint;

  try {
    const [currency0] = (await publicClient.readContract({
      address: feesManager,
      abi: feesManagerAbi,
      functionName: "getPoolKey",
      args: [poolId],
    })) as readonly [Address, Address, number, number, Address];

    const { result } = await publicClient.simulateContract({
      address: feesManager,
      abi: feesManagerAbi,
      functionName: "collectFees",
      args: [poolId],
      account: escrow,
    });
    const [fees0, fees1] = result as readonly [bigint, bigint];
    const pendingFee = sameAddress(currency0, weth) ? fees0 : fees1;
    return wethBalance + pendingFee;
  } catch {
    return wethBalance;
  }
}

/** Real, viem-backed {@link KeeperChainReader}. Typechecked but not fork-tested (see the report):
 * the decisions it feeds are exhaustively unit-tested above, and the underlying
 * `settleAuction`/`harvest`/`markDefault` calls it eventually drives are already fork-tested in
 * `chain/actions.fork.test.ts`. */
export function createLiveKeeperChainReader(params: {
  publicClient: PublicClient;
  hub: Address;
  usdc: Address;
  weth: Address;
}): KeeperChainReader {
  const { publicClient, hub, usdc, weth } = params;

  return {
    async loanCount() {
      return (await publicClient.readContract({ address: hub, abi: advanceHubAbi, functionName: "loanCount" })) as bigint;
    },

    async now() {
      const block = await publicClient.getBlock();
      return { blockNumber: block.number, timestamp: block.timestamp };
    },

    async loanSnapshot(loanId) {
      const loan = (await publicClient.readContract({
        address: hub,
        abi: advanceHubAbi,
        functionName: "loan",
        args: [loanId],
      })) as {
        ts: TermSheet;
        escrow: Address;
        note: Address;
        creditLine: Address;
        auction: Address;
        status: number;
      };

      const [creditLineState, auctionEndBlock, escrowPhase, lastRevenueAt, noteRemainingCap, escrowUsdcBalance, pendingWeth] =
        await Promise.all([
          publicClient.readContract({ address: loan.creditLine, abi: creditLineAbi, functionName: "state" }) as Promise<number>,
          publicClient.readContract({ address: loan.auction, abi: ccaAbi, functionName: "endBlock" }) as Promise<bigint>,
          publicClient.readContract({ address: loan.escrow, abi: revenueEscrowAbi, functionName: "phase" }) as Promise<number>,
          publicClient.readContract({
            address: loan.escrow,
            abi: revenueEscrowAbi,
            functionName: "lastRevenueAt",
          }) as Promise<bigint>,
          publicClient.readContract({
            address: loan.note,
            abi: revenueNoteAbi,
            functionName: "remainingCap",
          }) as Promise<bigint>,
          publicClient.readContract({
            address: usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [loan.escrow],
          }) as Promise<bigint>,
          pendingHarvestWeth({ publicClient, feesManager: loan.ts.feesManager, poolId: loan.ts.poolId, escrow: loan.escrow, weth }),
        ]);

      return {
        loanId,
        status: loan.status,
        creditLine: loan.creditLine,
        creditLineState,
        auction: loan.auction,
        auctionEndBlock,
        escrow: loan.escrow,
        escrowPhase,
        lastRevenueAt,
        gracePeriod: loan.ts.gracePeriod,
        pendingHarvestWeth: pendingWeth,
        noteRemainingCap,
        escrowUsdcBalance,
      };
    },
  };
}
