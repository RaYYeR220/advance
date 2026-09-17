import {
  type Address,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
} from "viem";
import { airlockAbi } from "../abis/airlock.js";
import { chainlinkAggregatorAbi } from "../abis/chainlinkAggregator.js";
import { feesManagerAbi, feesManagerLockEventAbi } from "../abis/feesManager.js";
import { poolManagerSwapEventAbi } from "../abis/poolManager.js";

export interface AssetStateRaw {
  status: number;
  dopplerHook: Address;
  poolKey: [Address, Address, number, number, Address];
}

export interface LockBeneficiary {
  beneficiary: Address;
  shares: bigint;
}

export interface AirlockAssetData {
  numeraire: Address;
  timelock: Address;
  governance: Address;
  liquidityMigrator: Address;
  poolInitializer: Address;
  pool: Address;
  migrationPool: Address;
  numTokensToSell: bigint;
  totalSupply: bigint;
  integrator: Address;
}

/** Simulated caller for the zero-share `collectFees` read (Spike 4 semantics). */
export const ZERO_SHARE_ADDRESS: Address =
  "0x000000000000000000000000000000000000bEEF";

/** `DopplerHookInitializer`'s `PoolStatus` enum (see `WrongPoolStatus`'s args). */
const POOL_STATUS_UNINITIALIZED = 0;
const POOL_STATUS_LOCKED = 2;

/**
 * `collectFees` reverts `WrongPoolStatus(expected, actual)` whenever the asset's status
 * isn't `Locked`. That is only safe to read as "zero fees have ever accrued" when
 * `actual` is genuinely `Uninitialized` (0) — i.e. a lookback block strictly before the
 * pool was locked. Any other `actual` status (`Initialized`, `Graduated`, `Exited`, ...)
 * reverting the same way is a real failure (e.g. a pool that later unwound) and must
 * propagate so callers fail closed instead of silently reporting zero revenue.
 */
export function isPreLockWrongPoolStatus(
  errorName: string | undefined,
  args: readonly unknown[] | undefined,
): boolean {
  if (errorName !== "WrongPoolStatus") return false;
  if (!args || args.length < 2) return false;
  const expected = Number(args[0]);
  const actual = Number(args[1]);
  return expected === POOL_STATUS_LOCKED && actual === POOL_STATUS_UNINITIALIZED;
}

export interface RawSwapLog {
  sender: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

/**
 * Low-level, semantically-named chain operations. This is the only layer that talks to
 * a transport (live RPC or recorded fixture) — everything else (`chainLogic.ts`) is pure
 * business logic written once against this interface, so fixture-backed tests exercise
 * the exact same code as production.
 */
export interface ChainOps {
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(block: bigint): Promise<bigint>;
  /** `eth_getCode` at `block`; `"0x"` means no contract deployed yet at that block. */
  getCode(address: Address, block: bigint): Promise<Hex>;
  getPoolKeyRaw(
    feesManager: Address,
    poolId: Hex,
  ): Promise<[Address, Address, number, number, Address]>;
  getShares(
    feesManager: Address,
    poolId: Hex,
    beneficiary: Address,
  ): Promise<bigint>;
  getCumulatedFees(
    feesManager: Address,
    poolId: Hex,
    index: 0 | 1,
    block: bigint,
  ): Promise<bigint>;
  /** `eth_call collectFees(poolId)` from `ZERO_SHARE_ADDRESS` at `block` → `[fees0, fees1]`. */
  getUncollectedFees(
    feesManager: Address,
    poolId: Hex,
    block: bigint,
  ): Promise<[bigint, bigint]>;
  /**
   * One `eth_getLogs` call for the `[fromBlock, toBlock]` range (caller chunks).
   * `cap` doesn't affect what's fetched live (the full raw range is always read) — it's
   * threaded through purely so fixture recording/replay can key and trim per the
   * caller's actual `getSwaps({ cap })`, instead of silently reusing a differently
   * capped (and therefore possibly truncated) recording for the same block range.
   */
  getSwapLogs(
    poolManager: Address,
    poolId: Hex,
    fromBlock: bigint,
    toBlock: bigint,
    cap: number,
  ): Promise<RawSwapLog[]>;
  getTransactionSender(hash: Hex): Promise<Address>;
  getLatestRoundData(
    feed: Address,
    block: bigint,
  ): Promise<[bigint, bigint, bigint, bigint, bigint]>;
  /** `eth_call decimals()` on a Chainlink aggregator, so the decimals guard in
   * `computeRevenue` checks a real on-chain read rather than an assumed constant. */
  getFeedDecimals(feed: Address, block: bigint): Promise<number>;
  /** `DopplerHookInitializer.getState(asset)` -> status, dopplerHook, and the full
   * `poolKey` (used both for pool eligibility and to bind the discovered `poolId` to the
   * token: `poolId` must equal `keccak256(abi.encode(poolKey))`). Not block-pinned — like
   * `getShares`/`getPoolKeyRaw`, this is a "what's true right now" read. */
  getAssetStateRaw(feesManager: Address, asset: Address): Promise<AssetStateRaw>;
  /** `DopplerHookInitializer.isDopplerHookEnabled(dopplerHook)` -> raw flags bitmask. */
  getDopplerHookFlags(feesManager: Address, dopplerHook: Address): Promise<bigint>;
  /** `eth_chainId` — used to guard against a `ChainReader` wired to the wrong network. */
  getChainId(): Promise<number>;
  /** `DopplerHookInitializer`'s `Lock` event for `asset`, decoded — the on-chain source of
   * "who are the beneficiaries and what are their shares" (`getState`'s default getter
   * can't return this: it's a dynamic array field). Used by the Airlock discovery source
   * to pick a creator without depending on Bankr. */
  getLockBeneficiaries(
    feesManager: Address,
    asset: Address,
  ): Promise<LockBeneficiary[]>;
  /** `Airlock.getAssetData(asset)` — the on-chain discovery source, cross-checked against
   * (or, off Base mainnet, used instead of) Bankr. */
  getAirlockAssetData(airlock: Address, asset: Address): Promise<AirlockAssetData>;
}

/** Live `ChainOps` backed by an archive-capable JSON-RPC endpoint. */
export function createLiveChainOps(rpcUrl: string): ChainOps {
  const client = createPublicClient({ transport: http(rpcUrl) });

  return {
    async getBlockNumber() {
      return client.getBlockNumber();
    },

    async getBlockTimestamp(block) {
      const b = await client.getBlock({ blockNumber: block });
      return b.timestamp;
    },

    async getCode(address, block) {
      const code = await client.getCode({ address, blockNumber: block });
      return code ?? "0x";
    },

    async getPoolKeyRaw(feesManager, poolId) {
      // uint24/int24 (<=48-bit) ABI ints decode to JS `number` in viem, not `bigint`.
      const [currency0, currency1, fee, tickSpacing, hooks] =
        await client.readContract({
          address: feesManager,
          abi: feesManagerAbi,
          functionName: "getPoolKey",
          args: [poolId],
        });
      return [currency0, currency1, fee, tickSpacing, hooks];
    },

    async getShares(feesManager, poolId, beneficiary) {
      return client.readContract({
        address: feesManager,
        abi: feesManagerAbi,
        functionName: "getShares",
        args: [poolId, beneficiary],
      });
    },

    async getCumulatedFees(feesManager, poolId, index, block) {
      return client.readContract({
        address: feesManager,
        abi: feesManagerAbi,
        functionName: index === 0 ? "getCumulatedFees0" : "getCumulatedFees1",
        args: [poolId],
        blockNumber: block,
      });
    },

    async getUncollectedFees(feesManager, poolId, block) {
      try {
        const { result } = await client.simulateContract({
          address: feesManager,
          abi: feesManagerAbi,
          functionName: "collectFees",
          args: [poolId],
          account: ZERO_SHARE_ADDRESS,
          blockNumber: block,
        });
        return [result[0], result[1]];
      } catch (err) {
        // A pool queried at a block before it was locked (e.g. the "from" block of a
        // lookback window on a very young token) reverts `WrongPoolStatus` — that
        // legitimately means zero fees had ever accrued at that block. Any other
        // revert/error is a real failure and must propagate (fail closed).
        if (err instanceof BaseError) {
          const revertError = err.walk(
            (e) => e instanceof ContractFunctionRevertedError,
          ) as ContractFunctionRevertedError | undefined;
          if (
            isPreLockWrongPoolStatus(
              revertError?.data?.errorName,
              revertError?.data?.args,
            )
          ) {
            return [0n, 0n];
          }
        }
        throw err;
      }
    },

    async getSwapLogs(poolManager, poolId, fromBlock, toBlock, _cap) {
      const logs = await client.getLogs({
        address: poolManager,
        event: poolManagerSwapEventAbi[0],
        args: { id: poolId },
        fromBlock,
        toBlock,
      });
      return logs.map((log) => ({
        sender: log.args.sender as Address,
        amount0: log.args.amount0 as bigint,
        amount1: log.args.amount1 as bigint,
        sqrtPriceX96: log.args.sqrtPriceX96 as bigint,
        liquidity: log.args.liquidity as bigint,
        // uint24/int24 (<=48-bit) ABI ints decode to JS `number` in viem, not `bigint`.
        tick: log.args.tick as number,
        fee: log.args.fee as number,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      }));
    },

    async getTransactionSender(hash) {
      const tx = await client.getTransaction({ hash });
      return tx.from;
    },

    async getLatestRoundData(feed, block) {
      const result = (await client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "latestRoundData",
        blockNumber: block,
      })) as [bigint, bigint, bigint, bigint, bigint];
      return result;
    },

    async getFeedDecimals(feed, block) {
      return client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "decimals",
        blockNumber: block,
      });
    },

    async getAssetStateRaw(feesManager, asset) {
      const [, , dopplerHook, , status, poolKey] = await client.readContract({
        address: feesManager,
        abi: feesManagerAbi,
        functionName: "getState",
        args: [asset],
      });
      return {
        status,
        dopplerHook,
        poolKey: [
          poolKey.currency0,
          poolKey.currency1,
          poolKey.fee,
          poolKey.tickSpacing,
          poolKey.hooks,
        ],
      };
    },

    async getDopplerHookFlags(feesManager, dopplerHook) {
      return client.readContract({
        address: feesManager,
        abi: feesManagerAbi,
        functionName: "isDopplerHookEnabled",
        args: [dopplerHook],
      });
    },

    async getChainId() {
      return client.getChainId();
    },

    async getLockBeneficiaries(feesManager, asset) {
      const logs = await client.getLogs({
        address: feesManager,
        event: feesManagerLockEventAbi[0],
        args: { asset },
        fromBlock: 0n,
        toBlock: "latest",
      });
      return logs.flatMap((log) =>
        (log.args.beneficiaries ?? []).map((b) => ({
          beneficiary: b.beneficiary,
          shares: b.shares,
        })),
      );
    },

    async getAirlockAssetData(airlock, asset) {
      const [
        numeraire,
        timelock,
        governance,
        liquidityMigrator,
        poolInitializer,
        pool,
        migrationPool,
        numTokensToSell,
        totalSupply,
        integrator,
      ] = await client.readContract({
        address: airlock,
        abi: airlockAbi,
        functionName: "getAssetData",
        args: [asset],
      });
      return {
        numeraire,
        timelock,
        governance,
        liquidityMigrator,
        poolInitializer,
        pool,
        migrationPool,
        numTokensToSell,
        totalSupply,
        integrator,
      };
    },
  };
}
