import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  BankrTokenNotFoundError,
  createFixtureBankrClient,
  type BankrTokenFeesResponse,
} from "../src/sources/bankr.js";
import type { ChainReader } from "../src/sources/chainLogic.js";
import {
  createAirlockDiscoverySource,
  createBankrDiscoverySource,
  DiscoveryNotFoundError,
} from "../src/sources/discovery.js";

const AIRLOCK: Address = "0x3333333333333333333333333333333333333333";
const KNOWN_FEES_MANAGER: Address = "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544";
const OTHER_FEES_MANAGER: Address = "0x9999999999999999999999999999999999999999";
const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const POOL_ID = "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6" as const;
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const MAJORITY: Address = "0x2222222222222222222222222222222222222222";
const PROTOCOL: Address = "0x4444444444444444444444444444444444444444";

function notImplemented(name: string) {
  return (...args: unknown[]) => {
    throw new Error(`fake ChainReader: "${name}" not implemented (args=${JSON.stringify(args)})`);
  };
}

interface FakeReaderOverrides {
  getAirlockAssetData?: ChainReader["getAirlockAssetData"];
  getAssetState?: ChainReader["getAssetState"];
  getLockBeneficiaries?: ChainReader["getLockBeneficiaries"];
  getShares?: ChainReader["getShares"];
}

function fakeReader(overrides: FakeReaderOverrides = {}): ChainReader {
  return {
    getPoolKey: notImplemented("getPoolKey") as ChainReader["getPoolKey"],
    getShares: (overrides.getShares ?? notImplemented("getShares")) as ChainReader["getShares"],
    getWethIndex: notImplemented("getWethIndex") as ChainReader["getWethIndex"],
    getFeeAccrual: notImplemented("getFeeAccrual") as ChainReader["getFeeAccrual"],
    getLatestBlock: notImplemented("getLatestBlock") as ChainReader["getLatestBlock"],
    getBlockTimestamp: notImplemented("getBlockTimestamp") as ChainReader["getBlockTimestamp"],
    blockAt: notImplemented("blockAt") as ChainReader["blockAt"],
    tokenCreatedAt: notImplemented("tokenCreatedAt") as ChainReader["tokenCreatedAt"],
    getCreatorRevenueWindow: notImplemented("getCreatorRevenueWindow") as ChainReader["getCreatorRevenueWindow"],
    getSwaps: notImplemented("getSwaps") as ChainReader["getSwaps"],
    getEthUsdPrice: notImplemented("getEthUsdPrice") as ChainReader["getEthUsdPrice"],
    getAssetState: (overrides.getAssetState ?? notImplemented("getAssetState")) as ChainReader["getAssetState"],
    getChainId: notImplemented("getChainId") as ChainReader["getChainId"],
    getLockBeneficiaries: (overrides.getLockBeneficiaries ??
      notImplemented("getLockBeneficiaries")) as ChainReader["getLockBeneficiaries"],
    getAirlockAssetData: (overrides.getAirlockAssetData ??
      notImplemented("getAirlockAssetData")) as ChainReader["getAirlockAssetData"],
  };
}

function assetData(overrides: Partial<Awaited<ReturnType<ChainReader["getAirlockAssetData"]>>> = {}) {
  return {
    numeraire: WETH,
    timelock: ZERO_ADDRESS,
    governance: ZERO_ADDRESS,
    liquidityMigrator: ZERO_ADDRESS,
    poolInitializer: KNOWN_FEES_MANAGER,
    pool: TOKEN,
    migrationPool: ZERO_ADDRESS,
    numTokensToSell: 0n,
    totalSupply: 0n,
    integrator: ZERO_ADDRESS,
    ...overrides,
  };
}

function assetState() {
  return {
    status: 2,
    dopplerHook: ZERO_ADDRESS,
    hookAllowsGraduation: false,
    poolKey: { currency0: WETH, currency1: TOKEN, fee: 8388608, tickSpacing: 200, hooks: KNOWN_FEES_MANAGER },
    poolId: POOL_ID,
  };
}

describe("createAirlockDiscoverySource", () => {
  it("resolves feesManager/poolId/numeraire and the majority-by-current-shares creator", async () => {
    const reader = fakeReader({
      async getAirlockAssetData() {
        return assetData();
      },
      async getAssetState() {
        return assetState();
      },
      async getLockBeneficiaries() {
        return [
          { beneficiary: PROTOCOL, shares: 50_000_000_000_000_000n },
          { beneficiary: MAJORITY, shares: 950_000_000_000_000_000n },
        ];
      },
      async getShares(_feesManager, _poolId, beneficiary) {
        // Current shares equal the Lock event's recorded shares here.
        return beneficiary.toLowerCase() === MAJORITY.toLowerCase()
          ? 950_000_000_000_000_000n
          : 50_000_000_000_000_000n;
      },
    });
    const source = createAirlockDiscoverySource(reader, AIRLOCK, KNOWN_FEES_MANAGER);
    const result = await source.discover(TOKEN);
    expect(result.source).toBe("airlock");
    expect(result.feesManager).toBe(KNOWN_FEES_MANAGER);
    expect(result.poolId).toBe(POOL_ID);
    expect(result.numeraire).toBe(WETH);
    expect(result.creator).toBe(MAJORITY);
  });

  it("picks the creator by CURRENT shares, not the Lock event's snapshot shares", async () => {
    // At lock time PROTOCOL held only 5%, but shares have since moved (e.g. via
    // updateBeneficiary) so PROTOCOL now holds the majority.
    const reader = fakeReader({
      async getAirlockAssetData() {
        return assetData();
      },
      async getAssetState() {
        return assetState();
      },
      async getLockBeneficiaries() {
        return [
          { beneficiary: PROTOCOL, shares: 50_000_000_000_000_000n },
          { beneficiary: MAJORITY, shares: 950_000_000_000_000_000n },
        ];
      },
      async getShares(_feesManager, _poolId, beneficiary) {
        return beneficiary.toLowerCase() === PROTOCOL.toLowerCase()
          ? 950_000_000_000_000_000n
          : 50_000_000_000_000_000n;
      },
    });
    const source = createAirlockDiscoverySource(reader, AIRLOCK, KNOWN_FEES_MANAGER);
    const result = await source.discover(TOKEN);
    expect(result.creator).toBe(PROTOCOL);
  });

  it("throws DiscoveryNotFoundError when poolInitializer is the zero address", async () => {
    const reader = fakeReader({
      async getAirlockAssetData() {
        return assetData({ poolInitializer: ZERO_ADDRESS });
      },
    });
    const source = createAirlockDiscoverySource(reader, AIRLOCK, KNOWN_FEES_MANAGER);
    await expect(source.discover(TOKEN)).rejects.toThrow(DiscoveryNotFoundError);
  });

  it("throws DiscoveryNotFoundError when poolInitializer isn't the chain's known FeesManager, before calling getState/getLogs", async () => {
    let getStateCalled = false;
    let getLogsCalled = false;
    const reader = fakeReader({
      async getAirlockAssetData() {
        return assetData({ poolInitializer: OTHER_FEES_MANAGER });
      },
      async getAssetState() {
        getStateCalled = true;
        return assetState();
      },
      async getLockBeneficiaries() {
        getLogsCalled = true;
        return [];
      },
    });
    const source = createAirlockDiscoverySource(reader, AIRLOCK, KNOWN_FEES_MANAGER);
    await expect(source.discover(TOKEN)).rejects.toThrow(DiscoveryNotFoundError);
    expect(getStateCalled).toBe(false);
    expect(getLogsCalled).toBe(false);
  });

  it("a genuine failure (not 'no pool') propagates instead of becoming DiscoveryNotFoundError", async () => {
    const reader = fakeReader({
      async getAirlockAssetData() {
        throw new Error("rpc timeout");
      },
    });
    const source = createAirlockDiscoverySource(reader, AIRLOCK, KNOWN_FEES_MANAGER);
    await expect(source.discover(TOKEN)).rejects.toThrow("rpc timeout");
  });

  it("creator is ZERO_ADDRESS (never fabricated) when no beneficiary holds a current majority", async () => {
    const reader = fakeReader({
      async getAirlockAssetData() {
        return assetData();
      },
      async getAssetState() {
        return assetState();
      },
      async getLockBeneficiaries() {
        return [
          { beneficiary: PROTOCOL, shares: 500_000_000_000_000_000n },
          { beneficiary: MAJORITY, shares: 500_000_000_000_000_000n },
        ];
      },
      async getShares() {
        return 500_000_000_000_000_000n;
      },
    });
    const source = createAirlockDiscoverySource(reader, AIRLOCK, KNOWN_FEES_MANAGER);
    const result = await source.discover(TOKEN);
    expect(result.creator).toBe(ZERO_ADDRESS);
  });
});

describe("createBankrDiscoverySource", () => {
  function bankrResponse(): BankrTokenFeesResponse {
    return {
      address: MAJORITY,
      chain: "base",
      days: 30,
      tokens: [
        {
          tokenAddress: TOKEN,
          name: "Test",
          symbol: "TEST",
          poolId: POOL_ID,
          initializer: KNOWN_FEES_MANAGER,
          share: "95.00%",
          token0Label: "WETH",
          token1Label: "TEST",
          numeraire: WETH,
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
      lifetimeBestDay: { date: "2026-01-01", weth: "0" },
      totals: { claimableWeth: "0", claimedWeth: "0", claimCount: 0 },
    };
  }

  it("resolves feesManager/poolId/numeraire/creator/name/symbol from the token-fees entry", async () => {
    const source = createBankrDiscoverySource(createFixtureBankrClient(bankrResponse()));
    const result = await source.discover(TOKEN);
    expect(result.source).toBe("bankr");
    expect(result.feesManager).toBe(KNOWN_FEES_MANAGER);
    expect(result.poolId).toBe(POOL_ID);
    expect(result.numeraire).toBe(WETH);
    expect(result.creator).toBe(MAJORITY);
    expect(result.tokenName).toBe("Test");
    expect(result.tokenSymbol).toBe("TEST");
  });

  it("throws DiscoveryNotFoundError when the Bankr client itself reports the token not found", async () => {
    const source = createBankrDiscoverySource({
      async getTokenFees(token) {
        throw new BankrTokenNotFoundError(token);
      },
    });
    await expect(source.discover(TOKEN)).rejects.toThrow(DiscoveryNotFoundError);
  });

  it("throws DiscoveryNotFoundError when the response doesn't contain this exact token", async () => {
    const response = bankrResponse();
    response.tokens[0]!.tokenAddress = "0x9999999999999999999999999999999999999999";
    const source = createBankrDiscoverySource(createFixtureBankrClient(response));
    await expect(source.discover(TOKEN)).rejects.toThrow(DiscoveryNotFoundError);
  });

  it("a genuine failure (not 'not found') propagates", async () => {
    const source = createBankrDiscoverySource({
      async getTokenFees() {
        throw new Error("bankr: unexpected status 500");
      },
    });
    await expect(source.discover(TOKEN)).rejects.toThrow("unexpected status 500");
  });
});
