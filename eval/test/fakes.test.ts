import { chainAddresses, score } from "@advance/core";
import { describe, expect, it } from "vitest";
import { addressFromSeed } from "../src/addr.js";
import { LATEST_BLOCK, LATEST_TIMESTAMP, dayBlock, dayIndexOfBlock, tokenCreationBlock } from "../src/blockModel.js";
import { createFakeBankrClient, createFakeChainOps, poolIdFor, resolveAddresses } from "../src/fakes.js";
import { buildScenarios } from "../src/gen.js";
import { realizedTop5Count } from "../src/swapMix.js";
import type { ScenarioParams } from "../src/types.js";

const scenarios = buildScenarios();
function scenario(id: string): ScenarioParams {
  const s = scenarios.find((sc) => sc.id === id);
  if (!s) throw new Error(`no such scenario: ${id}`);
  return s;
}

describe("blockModel", () => {
  it("dayBlock/dayIndexOfBlock round-trip for every day offset 0..30", () => {
    for (let m = 0; m <= 30; m++) {
      expect(dayIndexOfBlock(dayBlock(m))).toBe(m);
    }
  });

  it("dayIndexOfBlock rejects a block that isn't exactly on a day boundary", () => {
    expect(() => dayIndexOfBlock(dayBlock(3) + 1n)).toThrow();
  });

  it("tokenCreationBlock is exactly ageSeconds/2 blocks before latest", () => {
    const age = 10n * 86_400n;
    expect(LATEST_BLOCK - tokenCreationBlock(age)).toBe(age / 2n);
  });
});

describe("createFakeChainOps: fee accrual matches scenario.dailyFeesWei exactly", () => {
  it("healthy-1 (uniform daily accrual): every 1-day delta equals the configured daily value", async () => {
    const s = scenario("healthy-1");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const feesManager = chainAddresses(s.chainId).dopplerFeesManager;
    const POOL_ID = "0x00" as `0x${string}`;

    // currency0 is always the numeraire (WETH) slot in the fake's fixed pool-key layout.
    for (let m = 0; m < 7; m++) {
      const [today, yesterday] = await Promise.all([
        ops.getCumulatedFees(feesManager, POOL_ID, 0, dayBlock(m)),
        ops.getCumulatedFees(feesManager, POOL_ID, 0, dayBlock(m + 1)),
      ]);
      expect(today - yesterday).toBe(s.dailyFeesWei[m]);
    }
  });

  it("decaying-2: the 7-day and 30-day pool-wide deltas equal the sum of the matching prefix", () => {
    const s = scenario("decaying-2");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const feesManager = chainAddresses(s.chainId).dopplerFeesManager;
    const POOL_ID = "0x00" as `0x${string}`;

    const sum = (n: number) => s.dailyFeesWei.slice(0, n).reduce((a, b) => a + b, 0n);

    return Promise.all([
      ops.getCumulatedFees(feesManager, POOL_ID, 0, dayBlock(0)),
      ops.getCumulatedFees(feesManager, POOL_ID, 0, dayBlock(7)),
      ops.getCumulatedFees(feesManager, POOL_ID, 0, dayBlock(30)),
    ]).then(([latest, sevenDaysAgo, thirtyDaysAgo]) => {
      expect(latest - sevenDaysAgo).toBe(sum(7));
      expect(latest - thirtyDaysAgo).toBe(sum(30));
    });
  });

  it("getCode flips exactly at tokenCreationBlock for the token address, and is always present elsewhere", async () => {
    const s = scenario("too-young-2"); // ageSeconds = 2 days, easy to bracket
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const creation = tokenCreationBlock(s.ageSeconds);

    expect(await ops.getCode(addresses.token, creation - 1n)).toBe("0x");
    expect(await ops.getCode(addresses.token, creation)).not.toBe("0x");
    expect(await ops.getCode(addresses.creator, 1n)).not.toBe("0x");
  });
});

describe("createFakeChainOps: pool shape reflects scenario flags", () => {
  it("isWethPool=false puts a non-WETH address in the pool key (bnkr-paired-1)", async () => {
    const s = scenario("bnkr-paired-1");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const feesManager = chainAddresses(s.chainId).dopplerFeesManager;
    const raw = await ops.getAssetStateRaw(feesManager, addresses.token);
    const weth = chainAddresses(s.chainId).weth.toLowerCase();
    expect(raw.poolKey[0].toLowerCase()).not.toBe(weth);
    expect(raw.poolKey[1].toLowerCase()).not.toBe(weth);
  });

  it("isWethPool=true puts the chain's real WETH address in currency0 (healthy-1)", async () => {
    const s = scenario("healthy-1");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const feesManager = chainAddresses(s.chainId).dopplerFeesManager;
    const raw = await ops.getAssetStateRaw(feesManager, addresses.token);
    expect(raw.poolKey[0].toLowerCase()).toBe(chainAddresses(s.chainId).weth.toLowerCase());
  });

  it("graduation-flag: status is Locked but the hook flags carry ON_GRADUATION_FLAG (bit 1<<2)", async () => {
    const s = scenario("graduation-flag");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const feesManager = chainAddresses(s.chainId).dopplerFeesManager;
    const raw = await ops.getAssetStateRaw(feesManager, addresses.token);
    expect(raw.status).toBe(2); // Locked
    const flags = await ops.getDopplerHookFlags(feesManager, raw.dopplerHook);
    expect(flags & 4n).toBe(4n);
  });

  it("a poolLocked=false scenario would report a non-Locked status (sanity on the raw flag, not used by any built scenario)", () => {
    const s: ScenarioParams = { ...scenario("healthy-1"), id: "unlocked-sanity", poolLocked: false };
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const feesManager = chainAddresses(s.chainId).dopplerFeesManager;
    return ops.getAssetStateRaw(feesManager, addresses.token).then((raw) => {
      expect(raw.status).not.toBe(2);
    });
  });
});

describe("createFakeChainOps: synthetic swaps match swapMix.ts's realizedTop5Count exactly", () => {
  it("wash-3 (60/100 wash, no whales): the generated addresses' own top-5 sum equals realizedTop5Count, not washCount alone", async () => {
    const s = scenario("wash-3");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const poolManager = chainAddresses(s.chainId).poolManager;
    const raw = await ops.getSwapLogs(poolManager, "0x00" as `0x${string}`, dayBlock(7), dayBlock(0), 400);
    expect(raw.length).toBe(s.swaps.swapCount);

    const froms = await Promise.all(raw.map((r) => ops.getTransactionSender(r.transactionHash)));
    const washCount = froms.filter((f) => f.toLowerCase() === addresses.creator.toLowerCase()).length;
    expect(washCount).toBe(s.swaps.washCount);

    const counts = new Map<string, number>();
    for (const f of froms) counts.set(f.toLowerCase(), (counts.get(f.toLowerCase()) ?? 0) + 1);
    const top5 = [...counts.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    // No whales configured, so the top-5 sum is inflated above washCount by up to 4
    // one-off long-tail addresses backfilling the remaining slots — exactly what
    // realizedTop5Count predicts, and strictly more than washCount alone.
    expect(top5).toBe(realizedTop5Count(s.swaps));
    expect(top5).toBeGreaterThan(s.swaps.washCount);
  });

  it("concentrated-2 (4 whales, no wash): wash count is exactly zero, top5 sum equals realizedTop5Count", async () => {
    const s = scenario("concentrated-2");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const poolManager = chainAddresses(s.chainId).poolManager;
    const raw = await ops.getSwapLogs(poolManager, "0x00" as `0x${string}`, dayBlock(7), dayBlock(0), 400);
    const froms = await Promise.all(raw.map((r) => ops.getTransactionSender(r.transactionHash)));
    const washCount = froms.filter((f) => f.toLowerCase() === addresses.creator.toLowerCase()).length;
    expect(washCount).toBe(0);

    const counts = new Map<string, number>();
    for (const f of froms) counts.set(f.toLowerCase(), (counts.get(f.toLowerCase()) ?? 0) + 1);
    const top5 = [...counts.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    expect(top5).toBe(realizedTop5Count(s.swaps));
  });

  it("healthy-1 (creator + 4 whales, exactly 5 named addresses): no long-tail backfill, top5 == washCount + sum(whaleCounts)", async () => {
    const s = scenario("healthy-1");
    const addresses = resolveAddresses(s);
    const ops = createFakeChainOps(s, addresses);
    const poolManager = chainAddresses(s.chainId).poolManager;
    const raw = await ops.getSwapLogs(poolManager, "0x00" as `0x${string}`, dayBlock(7), dayBlock(0), 400);
    const froms = await Promise.all(raw.map((r) => ops.getTransactionSender(r.transactionHash)));
    const counts = new Map<string, number>();
    for (const f of froms) counts.set(f.toLowerCase(), (counts.get(f.toLowerCase()) ?? 0) + 1);
    const top5 = [...counts.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    const namedTotal = s.swaps.washCount + s.swaps.whaleCounts.reduce((a, b) => a + b, 0);
    expect(top5).toBe(namedTotal);
    expect(top5).toBe(realizedTop5Count(s.swaps));
  });
});

describe("createFakeBankrClient", () => {
  it("claims a poolId equal to computePoolId(poolKey), bound to the same feesManager the engine trusts", async () => {
    const s = scenario("healthy-3");
    const addresses = resolveAddresses(s);
    const bankr = createFakeBankrClient(s, addresses);
    const response = await bankr.getTokenFees(addresses.token);
    const entry = response.tokens[0]!;
    expect(entry.poolId).toBe(poolIdFor(s, addresses));
    expect(entry.initializer.toLowerCase()).toBe(chainAddresses(s.chainId).dopplerFeesManager.toLowerCase());
    expect(entry.numeraire.toLowerCase()).toBe(chainAddresses(s.chainId).weth.toLowerCase());
    expect(response.address.toLowerCase()).toBe(addresses.creator.toLowerCase());
  });
});

describe("integration sanity: score() over a couple of fakes, independent of answer-key.json", () => {
  it("healthy-1 is eligible with a positive cap, no llm section", async () => {
    const s = scenario("healthy-1");
    const addresses = resolveAddresses(s);
    const result = await score(
      {
        token: addresses.token,
        agentCard: addressFromSeed("test-agent-card"),
        agentId: 1n,
        chainId: s.chainId,
        hub: addressFromSeed("test-hub"),
        now: Number(LATEST_TIMESTAMP),
      },
      { bankr: createFakeBankrClient(s, addresses), chain: createFakeChainOps(s, addresses), env: { network: s.network } },
    );
    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") return;
    expect(result.terms.capMicroUsd).toBeGreaterThan(0n);
  });

  it("bnkr-paired-1 denies not_weth_pool", async () => {
    const s = scenario("bnkr-paired-1");
    const addresses = resolveAddresses(s);
    const result = await score(
      {
        token: addresses.token,
        agentCard: addressFromSeed("test-agent-card"),
        agentId: 1n,
        chainId: s.chainId,
        hub: addressFromSeed("test-hub"),
        now: Number(LATEST_TIMESTAMP),
      },
      { bankr: createFakeBankrClient(s, addresses), chain: createFakeChainOps(s, addresses), env: { network: s.network } },
    );
    expect(result.kind).toBe("deny");
    if (result.kind !== "deny") return;
    expect(result.reasons).toEqual(["not_weth_pool"]);
  });
});
