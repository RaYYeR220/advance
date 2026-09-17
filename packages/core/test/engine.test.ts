import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  createFixtureBankrClient,
  type BankrTokenFeesResponse,
} from "../src/sources/bankr.js";
import { createFixtureChainOps, type ChainFixture } from "../src/sources/chain.js";
import type { LlmClient, LlmMessage } from "../src/llm.js";
import { verifyTermSheet } from "../src/termsheet.js";
import {
  score,
  underwrite,
  type UnderwriteDeps,
  type UnderwriteInput,
} from "../src/underwrite/engine.js";
import type { UnderwritingEnv } from "../src/underwrite/terms.js";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const CHAIN_ID = 8453 as const;
const TEST_PRIVATE_KEY =
  "0x25c1a68a978b06379aa93931b26bef58b77c5fb7c64fd4bd5c93f490c085109c" as const;
const SIGNER_ADDRESS = privateKeyToAddress(TEST_PRIVATE_KEY);
const AGENT_CARD: Address = "0x1234567890123456789012345678901234567890";
const NOW = 1_790_000_000;

const MAINNET_ENV: UnderwritingEnv = { network: "mainnet" };

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = resolve(import.meta.dirname, `fixtures/${slug}/${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fakeLlm(complete: (messages: LlmMessage[]) => Promise<string>): LlmClient {
  return { complete };
}

const APPROVING_MEMO_TEXT = JSON.stringify({
  verdict: "approve",
  capMultiplierBps: 10000,
  floorCentsDelta: 0,
  rationale: "steady trailing creator revenue with reasonable trade quality",
  risks: [],
});

function approvingLlm(): LlmClient {
  return fakeLlm(async () => APPROVING_MEMO_TEXT);
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

describe("underwrite: Ratspeak (real fixture, approving LLM)", () => {
  it("approves with a deterministic TermsSummary snapshot and a signature that recovers to the signer", async () => {
    const ratspeakBankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const RATSPEAK_TOKEN = ratspeakChain.token as Address;

    const input = makeInput({ token: RATSPEAK_TOKEN });
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
    expect(decision.termSheet.deadline).toBe(BigInt(NOW) + 3600n);
    expect(decision.termSheet.memoHash).toBe(decision.evidenceHash);
    expect(decision.termSheet.nonce).toBeGreaterThan(0n);
    expect(decision.termSheet.nonce).toBeLessThan(2n ** 128n);
    expect(decision.evidence.llm).toBeDefined();

    const isValid = await verifyTermSheet(
      decision.termSheet,
      CHAIN_ID,
      HUB,
      decision.signature,
      SIGNER_ADDRESS,
    );
    expect(isValid).toBe(true);
  });
});

describe("underwrite: hard-rule denies", () => {
  it("BNKR-paired (deployer) fixture -> deny not_weth_pool", async () => {
    const deployerChain = loadFixture<ChainFixture>("deployer", "chain");
    const input = makeInput({ token: deployerChain.token as Address });
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
    const input = makeInput({ token: spiderChain.token as Address });
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
    const feesManagerKey = "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544";
    const statusKey = `${feesManagerKey}:${ratspeakChain.token}`;
    const notLockedChain: ChainFixture = {
      ...ratspeakChain,
      calls: {
        ...ratspeakChain.calls,
        poolStatus: {
          ...ratspeakChain.calls.poolStatus,
          [statusKey]: [1, "0x0000000000000000000000000000000000000000"], // Initialized, not Locked
        },
      },
    };
    const input = makeInput({ token: ratspeakChain.token as Address });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("ratspeak", "bankr")),
      chain: createFixtureChainOps(notLockedChain),
    });

    const decision = await underwrite(input, deps);
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reasons).toEqual(["pool_not_locked"]);
  });
});

describe("underwrite: memo and chain failures", () => {
  it("LLM down -> deny memo_unavailable, terms were still computed (evidence carries the llm section)", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("ratspeak", "bankr")),
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

  it("chain reader throwing -> deny data_unavailable, with a sanitized error message and no RPC URL/API key leak", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const brokenChain: ChainFixture = {
      ...ratspeakChain,
      calls: { ...ratspeakChain.calls, poolKeys: {} }, // getPoolKey now misses -> throws FixtureMissError
    };
    const input = makeInput({ token: ratspeakChain.token as Address });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("ratspeak", "bankr")),
      chain: createFixtureChainOps(brokenChain),
      llm: fakeLlm(async () => {
        throw new Error("should never be called: pool key lookup fails first");
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
});

describe("score: eligible and deny, no memo/signature", () => {
  it("Ratspeak -> eligible with computed terms, no llm section", async () => {
    const ratspeakChain = loadFixture<ChainFixture>("ratspeak", "chain");
    const input = makeInput({ token: ratspeakChain.token as Address });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("ratspeak", "bankr")),
      chain: createFixtureChainOps(ratspeakChain),
    });

    const result = await score(input, deps);
    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") return;
    expect(result.terms.capMicroUsd).toBeGreaterThan(0n);
    expect(result.terms.noteSupply).toBe(result.terms.capMicroUsd * 10n ** 12n);
    expect(result.evidence.llm).toBeUndefined();
    expect(result.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("deployer (BNKR-paired) -> deny not_weth_pool, no llm section", async () => {
    const deployerChain = loadFixture<ChainFixture>("deployer", "chain");
    const input = makeInput({ token: deployerChain.token as Address });
    const deps = makeDeps({
      bankr: createFixtureBankrClient(loadFixture("deployer", "bankr")),
      chain: createFixtureChainOps(deployerChain),
    });

    const result = await score(input, deps);
    expect(result.kind).toBe("deny");
    if (result.kind !== "deny") return;
    expect(result.reasons).toEqual(["not_weth_pool"]);
    expect(result.evidence.llm).toBeUndefined();
  });
});
