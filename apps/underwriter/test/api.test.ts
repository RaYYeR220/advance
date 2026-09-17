import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFixtureBankrClient,
  createFixtureChainOps,
  evidenceHash,
  verifyTermSheet,
  type BankrClient,
  type BankrTokenFeesResponse,
  type ChainFixture,
  type ChainOps,
  type EvidenceBundle,
  type LlmClient,
  type LlmMessage,
  type TermSheet,
} from "@advance/core";
import { createApp } from "../src/server.js";
import type { EvidenceStore } from "../src/store.js";
import type { UnderwriterConfig } from "../src/config.js";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const TEST_PRIVATE_KEY = "0x25c1a68a978b06379aa93931b26bef58b77c5fb7c64fd4bd5c93f490c085109c" as const;
const SIGNER_ADDRESS = privateKeyToAddress(TEST_PRIVATE_KEY);
const AGENT_CARD: Address = "0x1234567890123456789012345678901234567890";

const FIXTURES_ROOT = resolve(import.meta.dirname, "../../../packages/core/test/fixtures");

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = join(FIXTURES_ROOT, slug, `${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function latestTimestampOf(chain: ChainFixture): number {
  return Math.max(...Object.values(chain.calls.blocks).map(Number));
}

function fakeLlm(complete: (messages: LlmMessage[]) => Promise<string>): LlmClient {
  return { complete };
}

function approvingLlm(): LlmClient {
  return fakeLlm(async () =>
    JSON.stringify({
      verdict: "approve",
      capMultiplierBps: 10000,
      floorCentsDelta: 0,
      rationale: "steady trailing creator revenue with reasonable trade quality",
      risks: [],
    }),
  );
}

function unreachableLlm(): LlmClient {
  return fakeLlm(async () => {
    throw new Error("llm unexpectedly called");
  });
}

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "advance-underwriter-test-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

function testConfig(overrides: Partial<UnderwriterConfig> = {}): UnderwriterConfig {
  return {
    CHAIN_ID: 8453,
    BASE_RPC_URL: "https://rpc.invalid/base",
    BASE_SEPOLIA_RPC_URL: "https://rpc.invalid/base-sepolia",
    UNDERWRITER_PRIVATE_KEY: TEST_PRIVATE_KEY,
    ADVANCE_HUB: HUB,
    LLM_BASE_URL: "https://llm.invalid",
    LLM_MODEL: "test-model",
    EVIDENCE_DIR: evidenceDir,
    NETWORK: "mainnet",
    ...overrides,
  };
}

interface FixtureSet {
  chain: ChainFixture;
  bankr: BankrTokenFeesResponse;
  token: Address;
  now: number;
}

function loadRatspeak(): FixtureSet {
  const chain = loadFixture<ChainFixture>("ratspeak", "chain");
  const bankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
  return { chain, bankr, token: chain.token as Address, now: latestTimestampOf(chain) };
}

function loadSpider(): FixtureSet {
  const chain = loadFixture<ChainFixture>("spider", "chain");
  const bankr = loadFixture<BankrTokenFeesResponse>("spider", "bankr");
  return { chain, bankr, token: chain.token as Address, now: latestTimestampOf(chain) };
}

function chainOpsFor(fixture: FixtureSet): ChainOps {
  return createFixtureChainOps(fixture.chain);
}

function bankrFor(fixture: FixtureSet): BankrClient {
  return createFixtureBankrClient(fixture.bankr);
}

function buildApp(options: {
  fixture: FixtureSet;
  llm?: LlmClient;
  config?: Partial<UnderwriterConfig>;
  evidenceStore?: EvidenceStore;
  rateLimitNow?: () => number;
}) {
  return createApp(testConfig(options.config), {
    chain: chainOpsFor(options.fixture),
    bankr: bankrFor(options.fixture),
    llm: options.llm ?? approvingLlm(),
    now: () => options.fixture.now,
    evidenceStore: options.evidenceStore,
    rateLimitNow: options.rateLimitNow,
  });
}

function bigintFromJson(value: string | number): bigint {
  return BigInt(value);
}

describe("GET /health", () => {
  it("reports chain id and network", async () => {
    const app = buildApp({ fixture: loadRatspeak() });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", chainId: 8453, network: "mainnet" });
  });
});

describe("GET /v1/score/:token", () => {
  it("approved token: eligible shape with revenue/haircut/formula cap, no memo/signature", async () => {
    const fixture = loadRatspeak();
    const app = buildApp({ fixture, llm: unreachableLlm() });

    const res = await app.request(`/v1/score/${fixture.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.kind).toBe("eligible");
    expect((body.token as string).toLowerCase()).toBe(fixture.token.toLowerCase());
    expect(body).not.toHaveProperty("termSheet");
    expect(body).not.toHaveProperty("signature");

    const terms = body.terms as Record<string, unknown>;
    expect(typeof terms.capMicroUsd).toBe("string");
    expect(typeof terms.haircutBps).toBe("number");
    expect(typeof terms.minPrincipal).toBe("string");
    expect(typeof terms.drawLimit).toBe("string");
    const revenueMicroUsd = terms.revenueMicroUsd as Record<string, string>;
    expect(typeof revenueMicroUsd.d7).toBe("string");

    expect(body.evidenceHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("denied token (too young): deny shape with reasons, no terms", async () => {
    const fixture = loadSpider();
    const app = buildApp({ fixture, llm: unreachableLlm() });

    const res = await app.request(`/v1/score/${fixture.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.kind).toBe("deny");
    expect(body.reasons).toContain("too_young");
    expect(body).not.toHaveProperty("terms");
    expect(body.evidenceHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("400 on a malformed token address", async () => {
    const app = buildApp({ fixture: loadRatspeak() });
    const res = await app.request("/v1/score/not-an-address");
    expect(res.status).toBe(400);
  });

  it("caches a repeat lookup for the same token instead of recomputing", async () => {
    const fixture = loadRatspeak();
    let chainIdCalls = 0;
    const baseOps = chainOpsFor(fixture);
    const countingOps: ChainOps = {
      ...baseOps,
      async getChainId() {
        chainIdCalls += 1;
        return baseOps.getChainId();
      },
    };
    const app = createApp(testConfig(), {
      chain: countingOps,
      bankr: bankrFor(fixture),
      llm: unreachableLlm(),
      now: () => fixture.now,
    });

    const first = await app.request(`/v1/score/${fixture.token}`);
    const second = await app.request(`/v1/score/${fixture.token}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(chainIdCalls).toBe(1);
  });
});

describe("POST /v1/quote", () => {
  it("approves: signature recovers to the configured signer, terms match the formula", async () => {
    const fixture = loadRatspeak();
    const app = buildApp({ fixture });

    const res = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "88336", chainId: 8453 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("approve");

    const termSheetJson = body.termSheet as Record<string, string | number>;
    const termSheet: TermSheet = {
      agentTreasury: termSheetJson.agentTreasury as Address,
      agentCard: termSheetJson.agentCard as Address,
      agentId: bigintFromJson(termSheetJson.agentId as string),
      feesManager: termSheetJson.feesManager as Address,
      poolId: termSheetJson.poolId as `0x${string}`,
      expectedShares: bigintFromJson(termSheetJson.expectedShares as string),
      noteSupply: bigintFromJson(termSheetJson.noteSupply as string),
      floorCents: Number(termSheetJson.floorCents),
      minPrincipal: bigintFromJson(termSheetJson.minPrincipal as string),
      auctionBlocks: bigintFromJson(termSheetJson.auctionBlocks as string),
      drawLimit: bigintFromJson(termSheetJson.drawLimit as string),
      drawPeriod: bigintFromJson(termSheetJson.drawPeriod as string),
      gracePeriod: bigintFromJson(termSheetJson.gracePeriod as string),
      deadline: bigintFromJson(termSheetJson.deadline as string),
      nonce: bigintFromJson(termSheetJson.nonce as string),
      memoHash: termSheetJson.memoHash as `0x${string}`,
    };

    expect(termSheet.agentCard).toBe(AGENT_CARD);
    expect(termSheet.agentId).toBe(88336n);

    const isValid = await verifyTermSheet(termSheet, 8453, HUB, body.signature as `0x${string}`, SIGNER_ADDRESS);
    expect(isValid).toBe(true);
  });

  it("denies (too young): deny shape, no term sheet, no signature", async () => {
    const fixture = loadSpider();
    const app = buildApp({ fixture });

    const res = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: 8453 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("deny");
    expect(body.reasons).toContain("too_young");
    expect(body).not.toHaveProperty("termSheet");
    expect(body).not.toHaveProperty("signature");
  });

  it("400 on a malformed address in the body", async () => {
    const app = buildApp({ fixture: loadRatspeak() });
    const res = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-an-address", agentCard: AGENT_CARD, agentId: "1", chainId: 8453 }),
    });
    expect(res.status).toBe(400);
  });

  it("422 on an unsupported chainId (InvalidUnderwriteInput)", async () => {
    const fixture = loadRatspeak();
    const app = buildApp({ fixture });
    const res = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: 1 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /v1/evidence/:hash", () => {
  it("retrieves the stored bundle by hash, and re-hashing it reproduces the same hash", async () => {
    const fixture = loadRatspeak();
    const app = buildApp({ fixture });

    const quoteRes = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: 8453 }),
    });
    const quoteBody = (await quoteRes.json()) as { evidenceHash: string };

    const evidenceRes = await app.request(`/v1/evidence/${quoteBody.evidenceHash}`);
    expect(evidenceRes.status).toBe(200);
    const bundle = await evidenceRes.json();

    const rehash = evidenceHash(bundle as EvidenceBundle);
    expect(rehash).toBe(quoteBody.evidenceHash);
  });

  it("404 for an unknown (but well-formed) hash", async () => {
    const app = buildApp({ fixture: loadRatspeak() });
    const res = await app.request(`/v1/evidence/0x${"11".repeat(32)}`);
    expect(res.status).toBe(404);
  });

  it("400 for a malformed hash", async () => {
    const app = buildApp({ fixture: loadRatspeak() });
    const res = await app.request("/v1/evidence/not-a-hash");
    expect(res.status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("allows 30 requests per minute per IP and rejects the 31st with 429", async () => {
    const fixture = loadRatspeak();
    let fakeNow = 1_000_000;
    const app = buildApp({ fixture, llm: unreachableLlm(), rateLimitNow: () => fakeNow });

    for (let i = 0; i < 30; i++) {
      const res = await app.request(`/v1/score/${fixture.token}`, {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(res.status).not.toBe(429);
    }

    const res31 = await app.request(`/v1/score/${fixture.token}`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(res31.status).toBe(429);

    // A different IP still gets through — the limit is per-key, not global.
    const otherIp = await app.request(`/v1/score/${fixture.token}`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(otherIp.status).not.toBe(429);
  });
});

describe("error hygiene", () => {
  it("500 from an unexpected internal failure never leaks the response body's contents", async () => {
    const fixture = loadRatspeak();
    const secret = "sk-super-secret-underwriter-key-do-not-leak";
    const brokenStore: EvidenceStore = {
      save() {
        throw new Error(`disk failure while writing evidence (context: ${secret})`);
      },
      get() {
        return undefined;
      },
    };
    const app = buildApp({ fixture, evidenceStore: brokenStore });

    const res = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: 8453 }),
    });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(TEST_PRIVATE_KEY);
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
  });
});
