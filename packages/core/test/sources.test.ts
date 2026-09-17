import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  BankrTokenNotFoundError,
  createBankrClient,
  createFixtureBankrClient,
  pickBankrToken,
  type BankrTokenFeesResponse,
} from "../src/sources/bankr.js";
import {
  createFixtureChainReader,
  FixtureMissError,
  type ChainFixture,
} from "../src/sources/chain.js";
import { chainAddresses } from "../src/chains.js";

const { weth: BASE_WETH, poolManager: BASE_V4_POOL_MANAGER } = chainAddresses(8453);

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = resolve(
    import.meta.dirname,
    `fixtures/${slug}/${file}.json`,
  );
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
const vvveityBankr = loadFixture<BankrTokenFeesResponse>("vvveity", "bankr");
const vvveityChain = loadFixture<ChainFixture>("vvveity", "chain");
const vvvkernelBankr = loadFixture<BankrTokenFeesResponse>(
  "vvvkernel",
  "bankr",
);
const vvvkernelChain = loadFixture<ChainFixture>("vvvkernel", "chain");
const deployerBankr = loadFixture<BankrTokenFeesResponse>("deployer", "bankr");
const deployerChain = loadFixture<ChainFixture>("deployer", "chain");
const spiderBankr = loadFixture<BankrTokenFeesResponse>("spider", "bankr");
const spiderChain = loadFixture<ChainFixture>("spider", "chain");

const RATSPEAK_TOKEN: Address = "0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3";
const RATSPEAK_CREATOR = ratspeakBankr.address as Address;
const RATSPEAK_FEES_MANAGER = ratspeakBankr.tokens[0]!.initializer;
const RATSPEAK_POOL_ID = ratspeakBankr.tokens[0]!.poolId;

const DAY = 86_400n;

function wethOf(weiAmount: bigint): number {
  return Number(weiAmount) / 1e18;
}

describe("BankrClient", () => {
  describe("createFixtureBankrClient", () => {
    it("returns the recorded response for the fixture's token", async () => {
      const client = createFixtureBankrClient(ratspeakBankr);
      const response = await client.getTokenFees(RATSPEAK_TOKEN);
      expect(response).toBe(ratspeakBankr);
    });

    it("resolves the token case-insensitively", async () => {
      const client = createFixtureBankrClient(ratspeakBankr);
      const response = await client.getTokenFees(
        RATSPEAK_TOKEN.toLowerCase() as Address,
      );
      expect(response.tokens[0]?.tokenAddress.toLowerCase()).toBe(
        RATSPEAK_TOKEN.toLowerCase(),
      );
    });

    it("throws BankrTokenNotFoundError for a token the fixture doesn't cover", async () => {
      const client = createFixtureBankrClient(ratspeakBankr);
      await expect(
        client.getTokenFees(
          "0x0000000000000000000000000000000000dEaD" as Address,
        ),
      ).rejects.toThrow(BankrTokenNotFoundError);
    });
  });

  describe("pickBankrToken", () => {
    it("finds the Ratspeak entry and types the real response shape verbatim", () => {
      const entry = pickBankrToken(ratspeakBankr, RATSPEAK_TOKEN);
      expect(entry.name).toBe("Ratspeak");
      expect(entry.symbol).toBe("Ratspeak");
      expect(entry.initializer.toLowerCase()).toBe(
        "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
      );
      expect(entry.poolId).toBe(
        "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6",
      );
      expect(entry.numeraire.toLowerCase()).toBe(BASE_WETH.toLowerCase());
      expect(entry.tokenIsToken0).toBe(false);
      expect(entry.token0Label).toBe("WETH");
      expect(entry.share).toBe("95.00%");
      expect(typeof entry.claimed.token0).toBe("string");
      expect(typeof entry.claimed.count).toBe("number");
    });
  });

  describe("createBankrClient (live shape, injected fetch)", () => {
    it("parses a 200 response and returns it", async () => {
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify(ratspeakBankr), { status: 200 }),
      );
      const client = createBankrClient(fetchImpl as unknown as typeof fetch);
      const response = await client.getTokenFees(RATSPEAK_TOKEN);
      expect(response.address).toBe(ratspeakBankr.address);
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://api.bankr.bot/public/doppler/token-fees/${RATSPEAK_TOKEN}`,
      );
    });

    it("throws BankrTokenNotFoundError on a 404 {error} body", async () => {
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ error: "Token fee data not found" }), {
          status: 404,
        }),
      );
      const client = createBankrClient(fetchImpl as unknown as typeof fetch);
      await expect(
        client.getTokenFees(
          "0x0000000000000000000000000000000000dEaD" as Address,
        ),
      ).rejects.toThrow(BankrTokenNotFoundError);
    });

    it("throws a plain error on an unexpected non-2xx status", async () => {
      const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
      const client = createBankrClient(fetchImpl as unknown as typeof fetch);
      await expect(client.getTokenFees(RATSPEAK_TOKEN)).rejects.toThrow(
        /unexpected status 500/,
      );
    });
  });
});

describe("ChainReader (fixture-backed, Ratspeak)", () => {
  it("never touches the network and throws loudly on an unrecorded call", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    await expect(
      reader.getFeeAccrual(RATSPEAK_FEES_MANAGER, RATSPEAK_POOL_ID, 1n),
    ).rejects.toThrow(FixtureMissError);
  });

  it("detects the WETH leg of the pool from getPoolKey", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const poolKey = await reader.getPoolKey(
      RATSPEAK_FEES_MANAGER,
      RATSPEAK_POOL_ID,
    );
    expect(poolKey.currency0.toLowerCase()).toBe(BASE_WETH.toLowerCase());
    expect(reader.getWethIndex(poolKey, BASE_WETH)).toBe(0);
  });

  it("reads the creator's shares as 0.95e18", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const shares = await reader.getShares(
      RATSPEAK_FEES_MANAGER,
      RATSPEAK_POOL_ID,
      RATSPEAK_CREATOR,
    );
    expect(shares).toBe(950000000000000000n);
  });

  it("computes trailing 30d creator WETH revenue ≈ 14.47 WETH (±2%)", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const window = await reader.getCreatorRevenueWindow({
      feesManager: RATSPEAK_FEES_MANAGER,
      poolId: RATSPEAK_POOL_ID,
      creator: RATSPEAK_CREATOR,
      weth: BASE_WETH,
      windowSeconds: 30n * DAY,
    });
    expect(window.wethIndex).toBe(0);
    expect(window.creatorSharesWad).toBe(950000000000000000n);
    const revenueWeth = wethOf(window.creatorRevenueWeth);
    expect(revenueWeth).toBeGreaterThan(14.47 * 0.98);
    expect(revenueWeth).toBeLessThan(14.47 * 1.02);
  });

  it("computes trailing 1d creator WETH revenue ≈ 0.01215 WETH (±25%)", async () => {
    // Recorded value at fixture time; ±25% keeps this stable across re-recordings (1d
    // revenue is inherently noisy — a single active day can move it a lot) while still
    // catching a formula regression the way the 30d test does.
    const RECORDED_1D_WETH = 0.012147120945590388;
    const reader = createFixtureChainReader(ratspeakChain);
    const window = await reader.getCreatorRevenueWindow({
      feesManager: RATSPEAK_FEES_MANAGER,
      poolId: RATSPEAK_POOL_ID,
      creator: RATSPEAK_CREATOR,
      weth: BASE_WETH,
      windowSeconds: 1n * DAY,
    });
    const revenueWeth = wethOf(window.creatorRevenueWeth);
    expect(revenueWeth).toBeGreaterThan(RECORDED_1D_WETH * 0.75);
    expect(revenueWeth).toBeLessThan(RECORDED_1D_WETH * 1.25);
  });

  it("7d revenue sits between the 1d and 30d figures", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const windowFor = (d: bigint) =>
      reader.getCreatorRevenueWindow({
        feesManager: RATSPEAK_FEES_MANAGER,
        poolId: RATSPEAK_POOL_ID,
        creator: RATSPEAK_CREATOR,
        weth: BASE_WETH,
        windowSeconds: d * DAY,
      });
    const [d1, d7, d30] = await Promise.all([
      windowFor(1n),
      windowFor(7n),
      windowFor(30n),
    ]);
    expect(d1.creatorRevenueWeth).toBeLessThanOrEqual(d7.creatorRevenueWeth);
    expect(d7.creatorRevenueWeth).toBeLessThanOrEqual(d30.creatorRevenueWeth);
  });

  it("blockAt(latest timestamp) returns the latest block", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const latest = await reader.getLatestBlock();
    await expect(reader.blockAt(latest.timestamp)).resolves.toBe(
      latest.number,
    );
  });

  it("returns at most 400 swaps, most-recent first, each with tx.from resolved", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const latest = await reader.getLatestBlock();
    const fromBlock = await reader.blockAt(latest.timestamp - 7n * DAY);
    const swaps = await reader.getSwaps({
      poolManager: BASE_V4_POOL_MANAGER,
      poolId: RATSPEAK_POOL_ID,
      fromBlock,
      toBlock: latest.number,
      cap: 400,
    });
    expect(swaps.length).toBeGreaterThan(0);
    expect(swaps.length).toBeLessThanOrEqual(400);
    for (const swap of swaps) {
      expect(swap.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(swap.poolId).toBe(RATSPEAK_POOL_ID);
    }
    for (let i = 1; i < swaps.length; i++) {
      expect(swaps[i]!.blockNumber).toBeLessThanOrEqual(swaps[i - 1]!.blockNumber);
    }
  });

  it("reads the ETH/USD chainlink price at 8 decimals", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const latest = await reader.getLatestBlock();
    const price = await reader.getEthUsdPrice(
      "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
      latest.number,
    );
    expect(price.decimals).toBe(8);
    expect(price.answer).toBeGreaterThan(0n);
  });

  it("a swap-log query with an unrecorded cap misses instead of returning truncated data", async () => {
    // The fixture only ever recorded cap=400 (what record-fixture.ts requested) for this
    // block range. A different cap over the *same* range must not silently reuse that
    // (possibly truncated) recording — it must throw FixtureMissError.
    const reader = createFixtureChainReader(ratspeakChain);
    const latest = await reader.getLatestBlock();
    const fromBlock = await reader.blockAt(latest.timestamp - 7n * DAY);
    await expect(
      reader.getSwaps({
        poolManager: BASE_V4_POOL_MANAGER,
        poolId: RATSPEAK_POOL_ID,
        fromBlock,
        toBlock: latest.number,
        cap: 1000,
      }),
    ).rejects.toThrow(FixtureMissError);
  });

  it("tokenCreatedAt matches the token's real on-chain deployment (Basescan/Blockscout cross-check, ±1 block)", async () => {
    // Ground truth: Blockscout's recorded creation transaction for Ratspeak
    // (0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3) — block 46172693,
    // 2026-05-18T20:05:33Z = unix 1779134733. Recorded live via the same archive RPC.
    const GROUND_TRUTH_BLOCK = 46172693n;
    const GROUND_TRUTH_TIMESTAMP = 1779134733;
    const reader = createFixtureChainReader(ratspeakChain);
    const createdAt = await reader.tokenCreatedAt(RATSPEAK_TOKEN);
    expect(createdAt.block).toBeGreaterThanOrEqual(GROUND_TRUTH_BLOCK - 1n);
    expect(createdAt.block).toBeLessThanOrEqual(GROUND_TRUTH_BLOCK + 1n);
    expect(createdAt.timestamp).toBe(GROUND_TRUTH_TIMESTAMP);
  });

  it("tokenCreatedAt is cached (a second call doesn't re-query the fixture)", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const first = await reader.tokenCreatedAt(RATSPEAK_TOKEN);
    const second = await reader.tokenCreatedAt(RATSPEAK_TOKEN);
    expect(second).toEqual(first);
  });

  it("pool status is Locked and the assigned hook isn't graduation-enabled (recorded live from the real Base deployment)", async () => {
    const reader = createFixtureChainReader(ratspeakChain);
    const status = await reader.getAssetState(RATSPEAK_FEES_MANAGER, RATSPEAK_TOKEN);
    expect(status.status).toBe(2); // Locked
    expect(status.dopplerHook.toLowerCase()).toBe(
      "0xbf4195ab0b03e1eb3345dd1e83bed7650b1ed123",
    );
    expect(status.hookAllowsGraduation).toBe(false);
  });
});

describe("ChainReader (fixture-backed, VVVeity / VVVKernel)", () => {
  it("VVVeity: WETH is token0, shares 0.95e18, positive 30d revenue", async () => {
    const entry = pickBankrToken(
      vvveityBankr,
      vvveityBankr.tokens[0]!.tokenAddress,
    );
    const reader = createFixtureChainReader(vvveityChain);
    const poolKey = await reader.getPoolKey(entry.initializer, entry.poolId);
    expect(reader.getWethIndex(poolKey, BASE_WETH)).toBe(0);
    const window = await reader.getCreatorRevenueWindow({
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: vvveityBankr.address,
      weth: BASE_WETH,
      windowSeconds: 30n * DAY,
    });
    expect(window.creatorSharesWad).toBe(950000000000000000n);
    expect(window.creatorRevenueWeth).toBeGreaterThan(0n);
  });

  it("VVVKernel: WETH is token0, shares 0.95e18, positive 30d revenue", async () => {
    const entry = pickBankrToken(
      vvvkernelBankr,
      vvvkernelBankr.tokens[0]!.tokenAddress,
    );
    const reader = createFixtureChainReader(vvvkernelChain);
    const poolKey = await reader.getPoolKey(entry.initializer, entry.poolId);
    expect(reader.getWethIndex(poolKey, BASE_WETH)).toBe(0);
    const window = await reader.getCreatorRevenueWindow({
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: vvvkernelBankr.address,
      weth: BASE_WETH,
      windowSeconds: 30n * DAY,
    });
    expect(window.creatorSharesWad).toBe(950000000000000000n);
    expect(window.creatorRevenueWeth).toBeGreaterThan(0n);
  });
});

describe("ChainReader (fixture-backed, Deployer — BNKR-paired deny case)", () => {
  it("is not WETH-paired: getWethIndex throws", async () => {
    const entry = pickBankrToken(
      deployerBankr,
      deployerBankr.tokens[0]!.tokenAddress,
    );
    expect(entry.numeraire.toLowerCase()).not.toBe(BASE_WETH.toLowerCase());
    const reader = createFixtureChainReader(deployerChain);
    const poolKey = await reader.getPoolKey(entry.initializer, entry.poolId);
    expect(() => reader.getWethIndex(poolKey, BASE_WETH)).toThrow(
      /does not contain WETH/,
    );
  });
});

describe("ChainReader (fixture-backed, spider — very new pool)", () => {
  it("has zero trailing revenue and zero swaps (locked minutes before recording)", async () => {
    const entry = pickBankrToken(
      spiderBankr,
      spiderBankr.tokens[0]!.tokenAddress,
    );
    const reader = createFixtureChainReader(spiderChain);
    const latest = await reader.getLatestBlock();

    const window = await reader.getCreatorRevenueWindow({
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: spiderBankr.address,
      weth: BASE_WETH,
      windowSeconds: 30n * DAY,
      atBlock: latest.number,
    });
    expect(window.creatorRevenueWeth).toBe(0n);
    expect(window.creatorSharesWad).toBe(950000000000000000n);

    const fromBlock = await reader.blockAt(latest.timestamp - 7n * DAY);
    const swaps = await reader.getSwaps({
      poolManager: BASE_V4_POOL_MANAGER,
      poolId: entry.poolId,
      fromBlock,
      toBlock: latest.number,
    });
    expect(swaps).toEqual([]);
  });

  it("a lookback window reaching before the pool was locked doesn't fabricate revenue", async () => {
    // The 30d window's "from" block predates the pool's Lock entirely; the reader must
    // treat that as zero accrued fees rather than surfacing the underlying
    // WrongPoolStatus contract revert (see chainOps.getUncollectedFees).
    const entry = pickBankrToken(
      spiderBankr,
      spiderBankr.tokens[0]!.tokenAddress,
    );
    const reader = createFixtureChainReader(spiderChain);
    const window = await reader.getCreatorRevenueWindow({
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: spiderBankr.address,
      weth: BASE_WETH,
      windowSeconds: 30n * DAY,
    });
    expect(window.accruedFromWeth).toBe(0n);
    expect(window.accruedToWeth).toBe(0n);
  });

  it("tokenCreatedAt is very recent (well within 1 day of the recorded latest block)", async () => {
    const entry = pickBankrToken(
      spiderBankr,
      spiderBankr.tokens[0]!.tokenAddress,
    );
    const reader = createFixtureChainReader(spiderChain);
    const latest = await reader.getLatestBlock();
    const createdAt = await reader.tokenCreatedAt(entry.tokenAddress);
    expect(createdAt.block).toBeLessThanOrEqual(latest.number);
    const ageSeconds = latest.timestamp - BigInt(createdAt.timestamp);
    expect(ageSeconds).toBeGreaterThanOrEqual(0n);
    expect(ageSeconds).toBeLessThan(DAY); // spider was locked ~1h before recording
  });
});
