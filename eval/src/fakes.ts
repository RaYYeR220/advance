import type { Address, Hex } from "viem";
import {
  ZERO_ADDRESS,
  chainAddresses,
  computePoolId,
  type AirlockAssetData,
  type AssetStateRaw,
  type BankrClient,
  type BankrTokenFeesResponse,
  type ChainOps,
  type LockBeneficiary,
  type RawSwapLog,
} from "@advance/core";
import { addressFromSeed, hashFromSeed } from "./addr.js";
import { LATEST_BLOCK, blockTimestamp, dayIndexOfBlock, tokenCreationBlock } from "./blockModel.js";
import type { ResolvedAddresses, ScenarioParams } from "./types.js";

/** Baseline so `cumulativeAccrual` never goes negative for any prefix sum we subtract —
 * value itself is arbitrary (only deltas between two evaluated blocks are ever read). */
const TOTAL_BASELINE = 10n ** 30n;

export function resolveAddresses(scenario: ScenarioParams): ResolvedAddresses {
  const weth = chainAddresses(scenario.chainId).weth;
  return {
    token: addressFromSeed(`${scenario.id}-token`),
    creator: addressFromSeed(`${scenario.id}-creator`),
    numeraire: scenario.isWethPool ? weth : addressFromSeed(`${scenario.id}-bnkr-numeraire`),
    dopplerHook: addressFromSeed(`${scenario.id}-hook`),
  };
}

interface PoolKeyTuple {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

function poolKeyTupleFor(addresses: ResolvedAddresses): PoolKeyTuple {
  return {
    currency0: addresses.numeraire,
    currency1: addresses.token,
    fee: 3000,
    tickSpacing: 60,
    hooks: addresses.dopplerHook,
  };
}

export function poolIdFor(scenario: ScenarioParams, addresses: ResolvedAddresses): Hex {
  const t = poolKeyTupleFor(addresses);
  return computePoolId({
    currency0: t.currency0,
    currency1: t.currency1,
    fee: t.fee,
    tickSpacing: t.tickSpacing,
    hooks: t.hooks,
  });
}

interface SwapEntry {
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  from: Address;
}

/** Builds the concrete synthetic swap list (one swap per block, within the engine's
 * hardcoded 7-day swap lookback window) from a scenario's explicit `SwapMix`: `washCount`
 * swaps from the creator, `whaleCounts[i]` swaps from whale `i`, everything else a unique
 * one-off long-tail address. See `swapMix.ts` for why the *realized* top-5 concentration
 * count isn't simply `washCount + sum(whaleCounts)` when fewer than 5 named addresses are
 * active — this function just builds the addresses; `swapMix.ts` computes the ratio. */
function buildSwapPlan(scenario: ScenarioParams, addresses: ResolvedAddresses): SwapEntry[] {
  const { swapCount, washCount, whaleCounts } = scenario.swaps;
  if (swapCount === 0) return [];
  const whales = whaleCounts.map((_, i) => addressFromSeed(`${scenario.id}-whale-${i}`));
  const namedTotal = washCount + whaleCounts.reduce((a, b) => a + b, 0);
  const longTailTotal = swapCount - namedTotal;
  if (longTailTotal < 0) {
    throw new Error(`fakes: scenario "${scenario.id}" swaps.washCount+whaleCounts exceed swapCount`);
  }

  const froms: Address[] = [];
  for (let i = 0; i < washCount; i++) froms.push(addresses.creator);
  whales.forEach((w, i) => {
    for (let j = 0; j < whaleCounts[i]!; j++) froms.push(w);
  });
  for (let i = 0; i < longTailTotal; i++) froms.push(addressFromSeed(`${scenario.id}-tail-${i}`));

  // Spread across the 7-day lookback window (dayBlock(7)+1 .. dayBlock(0)=latest), one
  // swap per block, most-recent swaps last so they aren't trimmed by getSwaps' cap.
  return froms.map((from, i) => ({
    blockNumber: LATEST_BLOCK - BigInt(froms.length - 1 - i),
    transactionHash: hashFromSeed(`${scenario.id}-swap-${i}`),
    logIndex: 0,
    from,
  }));
}

function cumulativeAccrualAt(dailyFeesWei: readonly bigint[], block: bigint): bigint {
  const m = dayIndexOfBlock(block);
  let prefixSum = 0n;
  for (let i = 0; i < m; i++) prefixSum += dailyFeesWei[i] ?? 0n;
  return TOTAL_BASELINE - prefixSum;
}

export function createFakeChainOps(scenario: ScenarioParams, addresses: ResolvedAddresses): ChainOps {
  const poolKeyTuple = poolKeyTupleFor(addresses);
  const poolKeyRaw: [Address, Address, number, number, Address] = [
    poolKeyTuple.currency0,
    poolKeyTuple.currency1,
    poolKeyTuple.fee,
    poolKeyTuple.tickSpacing,
    poolKeyTuple.hooks,
  ];
  const creationBlock = tokenCreationBlock(scenario.ageSeconds);
  const swapPlan = buildSwapPlan(scenario, addresses);
  const senderByHash = new Map<Hex, Address>(swapPlan.map((s) => [s.transactionHash, s.from]));
  const feesManager = chainAddresses(scenario.chainId).dopplerFeesManager;

  return {
    async getBlockNumber() {
      return LATEST_BLOCK;
    },

    async getBlockTimestamp(block) {
      return blockTimestamp(block);
    },

    async getCode(address, block) {
      if (address.toLowerCase() === addresses.token.toLowerCase()) {
        return block >= creationBlock ? "0x1234" : "0x";
      }
      return "0x1234";
    },

    async getPoolKeyRaw(_feesManager, _poolId) {
      return poolKeyRaw;
    },

    async getShares(_feesManager, _poolId, beneficiary) {
      return beneficiary.toLowerCase() === addresses.creator.toLowerCase()
        ? scenario.creatorSharesWad
        : 0n;
    },

    async getCumulatedFees(_feesManager, _poolId, index, block) {
      // currency0 is always the numeraire slot in this fixed layout — the WETH side for
      // every WETH-paired scenario. Non-WETH scenarios never reach a fee read at all
      // (the engine denies not_weth_pool before computeRevenue runs).
      return index === 0 ? cumulativeAccrualAt(scenario.dailyFeesWei, block) : 0n;
    },

    async getUncollectedFees(_feesManager, _poolId, _block) {
      return [0n, 0n];
    },

    async getSwapLogs(_poolManager, _poolId, fromBlock, toBlock, _cap) {
      const logs: RawSwapLog[] = swapPlan
        .filter((s) => s.blockNumber >= fromBlock && s.blockNumber <= toBlock)
        .map((s) => ({
          sender: addressFromSeed("router"),
          amount0: 1n,
          amount1: 1n,
          sqrtPriceX96: 1n,
          liquidity: 1n,
          tick: 0,
          fee: 3000,
          blockNumber: s.blockNumber,
          transactionHash: s.transactionHash,
          logIndex: s.logIndex,
        }));
      return logs;
    },

    async getTransactionSender(hash) {
      const from = senderByHash.get(hash);
      if (!from) throw new Error(`fake chain: no synthetic sender recorded for tx ${hash}`);
      return from;
    },

    async getLatestRoundData(_feed, _block) {
      const updatedAt = blockTimestamp(LATEST_BLOCK) - scenario.ethUsdStalenessSeconds;
      return [1n, scenario.ethUsdAnswerE8, updatedAt, updatedAt, 1n];
    },

    async getFeedDecimals(_feed, _block) {
      return 8;
    },

    async getAssetStateRaw(_feesManager, _asset) {
      const raw: AssetStateRaw = {
        status: scenario.poolLocked ? 2 : 1,
        dopplerHook: addresses.dopplerHook,
        poolKey: poolKeyRaw,
      };
      return raw;
    },

    async getDopplerHookFlags(_feesManager, _dopplerHook) {
      return scenario.hookGraduationFlag ? 7n : 3n; // bit 1<<2 = ON_GRADUATION_FLAG
    },

    async getChainId() {
      return scenario.chainId;
    },

    async getLockBeneficiaries(_feesManager, _asset, _fromBlock, _toBlock) {
      const beneficiaries: LockBeneficiary[] = [
        { beneficiary: addresses.creator, shares: scenario.creatorSharesWad },
      ];
      return beneficiaries;
    },

    async getAirlockAssetData(_airlock, _asset) {
      const data: AirlockAssetData = {
        numeraire: addresses.numeraire,
        timelock: ZERO_ADDRESS,
        governance: ZERO_ADDRESS,
        liquidityMigrator: ZERO_ADDRESS,
        poolInitializer: feesManager,
        pool: ZERO_ADDRESS,
        migrationPool: ZERO_ADDRESS,
        numTokensToSell: 0n,
        totalSupply: 0n,
        integrator: ZERO_ADDRESS,
      };
      return data;
    },
  };
}

function sharePercentString(sharesWad: bigint): string {
  const hundredthsOfPercent = sharesWad / 10_000_000_000_000_000n; // 1e18 -> 1e2 (0.01% units)
  return `${(Number(hundredthsOfPercent) / 100).toFixed(2)}%`;
}

export function createFakeBankrClient(scenario: ScenarioParams, addresses: ResolvedAddresses): BankrClient {
  const feesManager = chainAddresses(scenario.chainId).dopplerFeesManager;
  const poolId = poolIdFor(scenario, addresses);
  return {
    async getTokenFees(_token) {
      const response: BankrTokenFeesResponse = {
        address: addresses.creator,
        chain: "base",
        days: 30,
        tokens: [
          {
            tokenAddress: addresses.token,
            name: scenario.tokenName,
            symbol: scenario.tokenSymbol,
            poolId,
            initializer: feesManager,
            share: sharePercentString(scenario.creatorSharesWad),
            token0Label: "NUMERAIRE",
            token1Label: scenario.tokenSymbol,
            numeraire: addresses.numeraire,
            tokenIsToken0: false,
            claimable: { token0: "0", token1: "0" },
            claimed: { token0: "0", token1: "0", count: 0 },
            source: "doppler",
            chain: "base",
          },
        ],
        dailyEarnings: [],
        allTimeDailyEarnings: [],
        lifetimeEarnedWeth: "0",
        lifetimeDays: 0,
        lifetimeBestDay: { date: "1970-01-01", weth: "0" },
        totals: { claimableWeth: "0", claimedWeth: "0", claimCount: 0 },
      };
      return response;
    },
  };
}

/** For Sepolia (Airlock-only) scenarios — proves Bankr is never actually called, the same
 * way `packages/core/test/engine.test.ts` does with its own `unreachableBankr()`. */
export function createUnreachableBankrClient(): BankrClient {
  return {
    async getTokenFees(token) {
      throw new Error(`fake bankr: unexpectedly called for ${token} (chain has Airlock-only discovery)`);
    },
  };
}
