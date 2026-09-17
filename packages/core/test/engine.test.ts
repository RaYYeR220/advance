import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  createFixtureBankrClient,
  type BankrClient,
  type BankrTokenFeesResponse,
} from "../src/sources/bankr.js";
import { createFixtureChainOps, type ChainFixture, type ChainOps } from "../src/sources/chain.js";
import type { LlmClient, LlmMessage } from "../src/llm.js";
import { verifyTermSheet } from "../src/termsheet.js";
import {
  InvalidUnderwriteInput,
  score,
  underwrite,
  type UnderwriteDeps,
  type UnderwriteInput,
} from "../src/underwrite/engine.js";
import { evidenceHash } from "../src/underwrite/evidence.js";
import type { UnderwritingEnv } from "../src/underwrite/terms.js";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const CHAIN_ID = 8453 as const;
const TEST_PRIVATE_KEY =
  "0x25c1a68a978b06379aa93931b26bef58b77c5fb7c64fd4bd5c93f490c085109c" as const;
const SIGNER_ADDRESS = privateKeyToAddress(TEST_PRIVATE_KEY);
const AGENT_CARD: Address = "0x1234567890123456789012345678901234567890";
const NOW = 1_790_000_000;
const RATSPEAK_FEES_MANAGER = "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544";
const MAINNET_AIRLOCK = "0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12";

const MAINNET_ENV: UnderwritingEnv = { network: "mainnet" };

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = resolve(import.meta.dirname, `fixtures/${slug}/${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fakeLlm(complete: (messages: LlmMessage[]) => Promise<string>): LlmClient {
  return { complete };
}

function memoText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: "approve",
    capMultiplierBps: 10000,
    floorCentsDelta: 0,
    rationale: "steady trailing creator revenue with reasonable trade quality",
    risks: [],
    ...overrides,
  });
}

function approvingLlm(): LlmClient {
  return fakeLlm(async () => memoText());
}

function unreachableBankr(): BankrClient {
  return {
    async getTokenFees(token) {
      throw new Error(`bankr unexpectedly called for ${token}`);
    },
  };
}

/** Recursively replaces bigints with decimal strings, for a snapshot-safe copy. */
function stringifyBigints(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigints);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stringifyBigints(v);
    }
    return out;
  }
  return value;
}

function makeInput(overrides: Partial<UnderwriteInput> = {}): UnderwriteInput {
  return {
    token: "0x0000000000000000000000000000000000dEaD",
    agentCard: AGENT_CARD,
    agentId: 88336n,
    chainId: CHAIN_ID,
    hub: HUB,
    now: NOW,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<UnderwriteDeps> = {}): UnderwriteDeps {
  return {
    bankr: createFixtureBankrClient(loadFixture("ratspeak", "bankr")),
    chain: createFixtureChainOps(loadFixture("ratspeak", "chain")),
    llm: approvingLlm(),
    signerKey: TEST_PRIVATE_KEY,
    env: MAINNET_ENV,
    ...overrides,
  };
}

/** The `ratspeak` fixture's own recorded block timestamp, so `input.now` in every test
 * satisfies the ±300s chain-time sanity check without hardcoding a value that would
 * silently rot the moment the fixture is re-recorded at a different block. */
function ratspeakLatestTimestamp(): number {
  const chain = loadFixture<ChainFixture>("ratspeak", "chain");
  const blocks = Object.values(chain.calls.blocks).map(Number);
  return Math.max(...blocks);
}

describe("underwrite: Ratspeak (real fixture, approving LLM)", () => {
  it("approves with a deterministic TermsSummary snapshot and a signature that recovers to the signer", async () => {
    const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const RATSPEAK_TOKEN = ratspeakChain.token as Address;

    const input = makeInput({ token: RATSPEAK_TOKEN, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(ratspeakBankr),
      chain: createFixtureChainOps(ratspeakChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("approve");
    if (decision.kind !== "approve") return;

    expect(stringifyBigints(decision.terms)).toMatchInlineSnapshot(`
      {
        "capMicroUsd": "25000000",
        "drawLimit": "714285",
        "drawPeriod": 86400,
        "floorCents": 80,
        "gracePeriod": 1209600,
        "haircutBps": 10000,
        "minPrincipal": "10000000",
        "projected90dMicroUsd": "1569592749",
        "revenueMicroUsd": {
          "d1": "28893841",
          "d30": "35035337432",
          "d7": "1413822537",
        },
        "revenueWei": {
          "d1": "11931936589348719",
          "d30": "14468115337626052181",
          "d7": "583849023052822456",
        },
      }
    `);

    expect(decision.termSheet.agentTreasury.toLowerCase()).toBe(
      ratspeakBankr.address,
    );
    expect(decision.termSheet.agentCard).toBe(AGENT_CARD);
    expect(decision.termSheet.expectedShares).toBe(950000000000000000n);
    expect(decision.termSheet.memoHash).toBe(decision.evidenceHash);
    expect(decision.termSheet.nonce).toBeGreaterThan(0n);
    expect(decision.termSheet.nonce).toBeLessThan(2n ** 128n);
    expect(decision.evidence.llm).toBeDefined();
    // Deadline is derived from chain time, not the caller's `now`.
    expect(decision.termSheet.deadline).toBe(BigInt(ratspeakLatestTimestamp()) + 3600n);

    const isValid = await verifyTermSheet(
      decision.termSheet,
      CHAIN_ID,
      HUB,
      decision.signature,
      SIGNER_ADDRESS,
    );
    expect(isValid).toBe(true);
  });

  it("input token/hub/agentCard casing doesn't matter: lowercase input reaches the same approval", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({
      token: (ratspeakChain.token as string).toLowerCase() as Address,
      hub: HUB.toLowerCase() as Address,
      agentCard: AGENT_CARD.toLowerCase() as Address,
      now: ratspeakLatestTimestamp(),
    });
    const decision = await underwrite(input, makeDeps());
    expect(decision.kind).toBe("approve");
  });
});

describe("underwrite: hard-rule denies", () => {
  it("BNKR-paired (deployer) fixture -> deny not_weth_pool", async () => {
    const deployerChain = loadFixture<ChainFixture>("deployer", "chain");
    const latest = Math.max(...Object.values(deployerChain.calls.blocks).map(Number));
    const input = makeInput({ token: deployerChain.token as Address, now: latest });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("deployer", "bankr")),
      chain: createFixtureChainOps(deployerChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["not_weth_pool"]);
    expect(decision.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decision.evidence.llm).toBeUndefined();
  });

  it("spider (locked hours before recording, no trailing revenue) -> deny too_young", async () => {
    const spiderChain = loadFixture<ChainFixture>("spider", "chain");
    const latest = Math.max(...Object.values(spiderChain.calls.blocks).map(Number));
    const input = makeInput({ token: spiderChain.token as Address, now: latest });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("spider", "bankr")),
      chain: createFixtureChainOps(spiderChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toContain("too_young");
  });

  it("pool status not Locked -> deny pool_not_locked", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const statusKey = `${RATSPEAK_FEES_MANAGER}:${ratspeakChain.token}`.toLowerCase();
    const original = ratspeakChain.calls.assetState[statusKey]!;
    const notLockedChain: ChainFixture = {
      ...ratspeakChain,
      calls: {
        ...ratspeakChain.calls,
        assetState: {
          ...ratspeakChain.calls.assetState,
          [statusKey]: { ...original, status: 1 }, // Initialized, not Locked
        },
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({ chain: createFixtureChainOps(notLockedChain) });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["pool_not_locked"]);
  });

  it("pool Locked but its hook is graduation-enabled -> deny pool_not_locked", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const hookKey = `${RATSPEAK_FEES_MANAGER}:0xBF4195ab0B03e1eB3345dd1e83BeD7650b1ed123`.toLowerCase();
    expect(ratspeakChain.calls.dopplerHookFlags[hookKey]).toBe("3"); // sanity: real flags, no graduation bit
    const graduationEnabledChain: ChainFixture = {
      ...ratspeakChain,
      calls: {
        ...ratspeakChain.calls,
        dopplerHookFlags: {
          ...ratspeakChain.calls.dopplerHookFlags,
          [hookKey]: "7", // adds ON_GRADUATION_FLAG (1<<2) on top of the real flags
        },
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({ chain: createFixtureChainOps(graduationEnabledChain) });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["pool_not_locked"]);
  });

  it("no pool found via either Bankr or Airlock -> deny not_bankr_doppler", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const unknownToken: Address = "0x9999999999999999999999999999999999999999";
    const airlockKey = `${MAINNET_AIRLOCK}:${unknownToken}`.toLowerCase();
    const chainWithMiss: ChainFixture = {
      ...ratspeakChain,
      token: unknownToken,
      calls: {
        ...ratspeakChain.calls,
        airlockAssetData: {
          [airlockKey]: {
            numeraire: "0x0000000000000000000000000000000000000000",
            timelock: "0x0000000000000000000000000000000000000000",
            governance: "0x0000000000000000000000000000000000000000",
            liquidityMigrator: "0x0000000000000000000000000000000000000000",
            poolInitializer: "0x0000000000000000000000000000000000000000",
            pool: "0x0000000000000000000000000000000000000000",
            migrationPool: "0x0000000000000000000000000000000000000000",
            numTokensToSell: "0",
            totalSupply: "0",
            integrator: "0x0000000000000000000000000000000000000000",
          },
        },
      },
    };
    const input = makeInput({ token: unknownToken, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      // Ratspeak's bankr fixture doesn't contain `unknownToken` -> BankrTokenNotFoundError.
      bankr: createFixtureBankrClient(loadFixture("ratspeak", "bankr")),
      chain: createFixtureChainOps(chainWithMiss),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["not_bankr_doppler"]);
  });
});

describe("underwrite: discovery guards (fixture mutations)", () => {
  it("chain-id guard: reader reports 84532 while input.chainId is 8453 -> deny data_unavailable, LLM never called", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const wrongChainId: ChainFixture = {
      ...ratspeakChain,
      calls: { ...ratspeakChain.calls, chainId: 84532 },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    let llmCalled = false;
    const deps = makeDeps({
      chain: createFixtureChainOps(wrongChainId),
      llm: fakeLlm(async () => {
        llmCalled = true;
        return memoText();
      }),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(llmCalled).toBe(false);
  });

  it("Airlock's numeraire disagrees with Bankr's -> deny data_unavailable, both views in evidence.discovery", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const airlockKey = `${MAINNET_AIRLOCK}:${ratspeakChain.token}`.toLowerCase();
    const original = ratspeakChain.calls.airlockAssetData[airlockKey]!;
    const mutated: ChainFixture = {
      ...ratspeakChain,
      calls: {
        ...ratspeakChain.calls,
        airlockAssetData: {
          ...ratspeakChain.calls.airlockAssetData,
          [airlockKey]: { ...original, numeraire: "0x1234567890123456789012345678901234567890" },
        },
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({ chain: createFixtureChainOps(mutated) });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(decision.evidence.discovery?.bankr).toBeDefined();
    expect(decision.evidence.discovery?.airlock).toBeDefined();
  });

  it(
    "Bankr's poolId fails the independent on-chain binding check -> deny not_bankr_doppler " +
      "(binding runs before the Bankr/Airlock agreement check, so a provably wrong poolId " +
      "wins even though Airlock would otherwise 'disagree' with it — see resolveDiscovery)",
    async () => {
      const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
      const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
      const wrongPoolId = `0x${"1".repeat(64)}` as const;
      const mutatedBankr: BankrTokenFeesResponse = {
        ...ratspeakBankr,
        tokens: [{ ...ratspeakBankr.tokens[0]!, poolId: wrongPoolId }],
      };
      const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
      const deps = makeDeps({
        bankr: createFixtureBankrClient(mutatedBankr),
        chain: createFixtureChainOps(ratspeakChain),
      });

      const decision = await underwrite(input, deps);
      expect(decision.kind).toBe("deny");
      if (decision.kind !== "deny") return;
      expect(decision.reasons).toEqual(["not_bankr_doppler"]);
      expect(decision.evidence.discovery?.bankr).toBeDefined();
    },
  );

  it("Bankr finds a pool but Airlock doesn't (one-sided) -> deny data_unavailable", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const airlockKey = `${MAINNET_AIRLOCK}:${ratspeakChain.token}`.toLowerCase();
    const mutated: ChainFixture = {
      ...ratspeakChain,
      calls: {
        ...ratspeakChain.calls,
        airlockAssetData: {
          ...ratspeakChain.calls.airlockAssetData,
          [airlockKey]: {
            ...ratspeakChain.calls.airlockAssetData[airlockKey]!,
            poolInitializer: "0x0000000000000000000000000000000000000000",
          },
        },
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({ chain: createFixtureChainOps(mutated) });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(decision.evidence.discovery?.bankr).toBeDefined();
    expect(decision.evidence.discovery?.airlock).toBeUndefined();
  });

  it("Airlock finds a pool but Bankr doesn't (one-sided) -> deny data_unavailable", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const emptyBankr: BankrTokenFeesResponse = { ...ratspeakBankr, tokens: [] };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(emptyBankr),
      chain: createFixtureChainOps(ratspeakChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(decision.evidence.discovery?.bankr).toBeUndefined();
    expect(decision.evidence.discovery?.airlock).toBeDefined();
  });

  it("both sources report the same unknown initializer -> deny not_bankr_doppler", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const UNKNOWN: Address = "0x9999999999999999999999999999999999999999";
    const mutatedBankr: BankrTokenFeesResponse = {
      ...ratspeakBankr,
      tokens: [{ ...ratspeakBankr.tokens[0]!, initializer: UNKNOWN }],
    };
    const airlockKey = `${MAINNET_AIRLOCK}:${ratspeakChain.token}`.toLowerCase();
    const mutatedChain: ChainFixture = {
      ...ratspeakChain,
      calls: {
        ...ratspeakChain.calls,
        airlockAssetData: {
          ...ratspeakChain.calls.airlockAssetData,
          [airlockKey]: { ...ratspeakChain.calls.airlockAssetData[airlockKey]!, poolInitializer: UNKNOWN },
        },
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(mutatedBankr),
      chain: createFixtureChainOps(mutatedChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["not_bankr_doppler"]);
  });

  it("Bankr claims an unknown feesManager while Airlock still resolves the real one -> deny not_bankr_doppler via the independent binding check", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const UNKNOWN: Address = "0x9999999999999999999999999999999999999999";
    const mutatedBankr: BankrTokenFeesResponse = {
      ...ratspeakBankr,
      tokens: [{ ...ratspeakBankr.tokens[0]!, initializer: UNKNOWN }],
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(mutatedBankr),
      chain: createFixtureChainOps(ratspeakChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["not_bankr_doppler"]);
  });

  it("Bankr's claimed creator isn't one of the pool's Lock beneficiaries -> deny data_unavailable, both views in evidence", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const NOT_A_BENEFICIARY: Address = "0x8888888888888888888888888888888888888888";
    const mutatedBankr: BankrTokenFeesResponse = { ...ratspeakBankr, address: NOT_A_BENEFICIARY };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(mutatedBankr),
      chain: createFixtureChainOps(ratspeakChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(decision.evidence.discovery?.bankr).toBeDefined();
    expect(decision.evidence.discovery?.airlock).toBeDefined();
  });

  it("isEscrowed resolving true -> deny already_escrowed", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      chain: createFixtureChainOps(ratspeakChain),
      isEscrowed: async () => true,
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toContain("already_escrowed");
  });
});

describe("underwrite: memo outcomes", () => {
  it("LLM down -> deny memo_unavailable, terms were still computed (evidence carries the llm section)", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      chain: createFixtureChainOps(ratspeakChain),
      llm: fakeLlm(async () => {
        throw new Error("LLM request failed with HTTP 500: internal error");
      }),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["memo_unavailable"]);
    expect(decision.evidence.llm).toBeDefined();
    expect(decision.evidence.formula.computedTerms.capMicroUsd).toBeGreaterThan(0n);
  });

  it("memo verdict deny -> deny memo_denied regardless of the multiplier/delta", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      chain: createFixtureChainOps(ratspeakChain),
      llm: fakeLlm(async () => memoText({ verdict: "deny", capMultiplierBps: 10000, floorCentsDelta: 0 })),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["memo_denied"]);
    expect(decision.evidence.llm).toBeDefined();
  });

  it("a heavy post-memo tighten that pushes minPrincipal under $1 -> deny below_minimum", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      chain: createFixtureChainOps(ratspeakChain),
      llm: fakeLlm(async () => memoText({ verdict: "tighten", capMultiplierBps: 1, floorCentsDelta: 0 })),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["below_minimum"]);
    expect(decision.evidence.llm).toBeDefined();
  });
});

describe("underwrite: chain failures and evidence integrity", () => {
  it("chain reader throwing -> deny data_unavailable, with a sanitized error message and no RPC URL/API key leak", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const brokenChain: ChainFixture = {
      ...ratspeakChain,
      calls: { ...ratspeakChain.calls, poolKeys: {} }, // computeRevenue's getPoolKey now misses
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({
      chain: createFixtureChainOps(brokenChain),
      llm: fakeLlm(async () => {
        throw new Error("should never be called: revenue computation fails first");
      }),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(decision.evidence.error).toBeTruthy();
    expect(decision.evidence.error).not.toMatch(/https?:\/\//);
    expect(decision.evidence.error).not.toMatch(/UNDERWRITER_PRIVATE_KEY|api[_-]?key/i);
  });

  it("redacts a wss:// URL from an error message, not just http(s)://", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const secretUrl = "wss://base-mainnet.g.alchemy.com/v2/SECRETKEY";
    const throwingChain: ChainOps = {
      ...createFixtureChainOps(ratspeakChain),
      async getPoolKeyRaw() {
        throw new Error(`rpc down at ${secretUrl}`);
      },
    };
    const deps = makeDeps({ chain: throwingChain });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);
    expect(decision.evidence.error).toBeTruthy();
    expect(decision.evidence.error).not.toContain("SECRETKEY");
    expect(decision.evidence.error).not.toMatch(/wss?:\/\//);
  });

  it("a parallel read that keeps resolving after an early failure doesn't corrupt the evidence hash", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const base = createFixtureChainOps(ratspeakChain);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ops: ChainOps = {
      ...base,
      async getFeedDecimals() {
        throw new Error("rpc down");
      },
      async getCumulatedFees(...args: Parameters<ChainOps["getCumulatedFees"]>) {
        await sleep(50);
        return base.getCumulatedFees(...args);
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = makeDeps({ chain: ops });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["data_unavailable"]);

    // The hash must match right away...
    expect(evidenceHash(decision.evidence)).toBe(decision.evidenceHash);
    // ...and still match well after the slow, already-in-flight getCumulatedFees calls
    // have settled and (if `dump()` weren't snapshotted) would have mutated the same
    // `evidence.rawReads` object the hash was already computed from.
    await sleep(200);
    expect(evidenceHash(decision.evidence)).toBe(decision.evidenceHash);
  });
});

describe("underwrite: input validation (InvalidUnderwriteInput, never a deny)", () => {
  it("a malformed hub address throws InvalidUnderwriteInput", async () => {
    const input = makeInput({ hub: "not-an-address" as Address });
    await expect(underwrite(input, makeDeps())).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("a malformed signerKey throws InvalidUnderwriteInput", async () => {
    const input = makeInput();
    await expect(
      underwrite(input, makeDeps({ signerKey: "0xnothex" as `0x${string}` })),
    ).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("a negative agentId throws InvalidUnderwriteInput", async () => {
    const input = makeInput({ agentId: -1n });
    await expect(underwrite(input, makeDeps())).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("an unsupported chainId throws InvalidUnderwriteInput", async () => {
    const input = makeInput({ chainId: 1 as unknown as 8453 });
    await expect(underwrite(input, makeDeps())).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("a hardCeiling above the mainnet policy limit throws InvalidUnderwriteInput", async () => {
    const input = makeInput();
    const deps = makeDeps({ env: { network: "mainnet", hardCeilingMicroUsd: 1_000_000_000n } });
    await expect(underwrite(input, deps)).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("now more than 300s from chain time throws InvalidUnderwriteInput (not a deny)", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({
      token: ratspeakChain.token as Address,
      now: ratspeakLatestTimestamp() + 10_000,
    });
    await expect(underwrite(input, makeDeps())).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("now within 300s of chain time is accepted", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({
      token: ratspeakChain.token as Address,
      now: ratspeakLatestTimestamp() + 100,
    });
    const decision = await underwrite(input, makeDeps());
    expect(decision.kind).toBe("approve");
  });

  it("chainId 8453 with env.network 'demo' throws InvalidUnderwriteInput (would sign a mainnet term sheet against the $10k demo ceiling)", async () => {
    // Otherwise-valid input (real token, chain time in range) so the *only* possible
    // rejection reason is the chainId/env.network binding itself, not clock skew or a
    // token discovery miss.
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({
      chainId: 8453,
      token: ratspeakChain.token as Address,
      now: ratspeakLatestTimestamp(),
    });
    const deps = makeDeps({ chain: createFixtureChainOps(ratspeakChain), env: { network: "demo" } });
    await expect(underwrite(input, deps)).rejects.toThrow(InvalidUnderwriteInput);
  });

  it("chainId 84532 with env.network 'mainnet' throws InvalidUnderwriteInput", async () => {
    const sepoliaChain = loadFixture<ChainFixture>("sepolia-test", "chain");
    const latest = Math.max(...Object.values(sepoliaChain.calls.blocks).map(Number));
    const input = makeInput({ chainId: 84532, token: sepoliaChain.token as Address, now: latest });
    const deps = makeDeps({
      bankr: unreachableBankr(),
      chain: createFixtureChainOps(sepoliaChain),
      env: { network: "mainnet" },
    });
    await expect(underwrite(input, deps)).rejects.toThrow(InvalidUnderwriteInput);
  });
});

describe("score: eligible and deny, no memo/signature", () => {
  it("Ratspeak -> eligible with computed terms, token set, no llm section", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address, now: ratspeakLatestTimestamp() });
    const deps = { bankr: makeDeps().bankr, chain: createFixtureChainOps(ratspeakChain), env: MAINNET_ENV };

    const result = await score(input, deps);
    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") return;
    expect(result.token).toBe(input.token);
    expect(result.terms.capMicroUsd).toBeGreaterThan(0n);
    expect(result.terms.noteSupply).toBe(result.terms.capMicroUsd * 10n ** 12n);
    expect(result.evidence.llm).toBeUndefined();
    expect(result.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("deployer (BNKR-paired) -> deny not_weth_pool, token set, no llm section", async () => {
    const deployerChain = loadFixture<ChainFixture>("deployer", "chain");
    const latest = Math.max(...Object.values(deployerChain.calls.blocks).map(Number));
    const input = makeInput({ token: deployerChain.token as Address, now: latest });
    const deps = {
      bankr: createFixtureBankrClient(loadFixture("deployer", "bankr")),
      chain: createFixtureChainOps(deployerChain),
      env: MAINNET_ENV,
    };

    const result = await score(input, deps);
    expect(result.kind).toBe("deny");
    if (result.kind !== "deny") return;
    expect(result.token).toBe(input.token);
    expect(result.reasons).toEqual(["not_weth_pool"]);
    expect(result.evidence.llm).toBeUndefined();
  });
});

describe("underwrite: Base Sepolia (Airlock-only discovery, real recorded fixture)", () => {
  it("the real Sepolia test-launch token underwrites end to end via Airlock discovery alone, denying for lack of revenue", async () => {
    const sepoliaChain = loadFixture<ChainFixture>("sepolia-test", "chain");
    const latest = Math.max(...Object.values(sepoliaChain.calls.blocks).map(Number));
    const input = makeInput({
      token: sepoliaChain.token as Address,
      chainId: 84532,
      now: latest,
    });
    const deps = makeDeps({
      bankr: unreachableBankr(), // Bankr has no Sepolia data; must never be called
      chain: createFixtureChainOps(sepoliaChain),
      env: { network: "demo" },
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    // Recorded live: a just-launched pool with no trailing revenue yet.
    expect(decision.reasons).toContain("too_young");
    expect(decision.evidence.chainId).toBe(84532);
    expect(decision.evidence.feesManager.toLowerCase()).toBe(
      RATSPEAK_FEES_MANAGER.toLowerCase(), // same deterministic Doppler deployment on both chains
    );
  });
});
