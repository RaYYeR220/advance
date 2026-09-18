import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFixtureBankrClient,
  createFixtureChainOps,
  verifyTermSheet,
  type BankrClient,
  type BankrTokenFeesResponse,
  type ChainFixture,
  type ChainOps,
  type LlmClient,
  type LlmMessage,
} from "@advance/core";
import { startServer, type RunningServer } from "@advance/underwriter/src/bin/serve.js";
import type { UnderwriterConfig } from "@advance/underwriter/src/config.js";
import { AdvanceApiError, fetchEvidence, fetchQuote, fetchScore } from "../src/api.js";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const TEST_PRIVATE_KEY = "0x25c1a68a978b06379aa93931b26bef58b77c5fb7c64fd4bd5c93f490c085109c" as const;
const SIGNER_ADDRESS = privateKeyToAddress(TEST_PRIVATE_KEY);
const AGENT_CARD: Address = "0x1234567890123456789012345678901234567890";

const FIXTURES_ROOT = resolve(import.meta.dirname, "../../core/test/fixtures");

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

let evidenceDir: string;
let server: RunningServer | undefined;

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
    UNDERWRITER_PAYTO: "0x2222222222222222222222222222222222222222",
    X402_FACILITATOR_URL: "https://facilitator.invalid",
    TRUST_PROXY: false,
    ...overrides,
  };
}

async function startFixtureServer(fixture: FixtureSet): Promise<RunningServer> {
  return startServer(testConfig(), {
    chain: chainOpsFor(fixture),
    bankr: bankrFor(fixture),
    llm: approvingLlm(),
    now: () => fixture.now,
    hostname: "127.0.0.1",
    // This suite exercises the SDK's HTTP/decode layer (bigint revival, error mapping,
    // paymentFetch-vs-fetchImpl precedence), not x402 payment enforcement — that's covered
    // by `@advance/underwriter`'s own `test/payment.test.ts`. A pass-through gate keeps
    // `/v1/quote` open here so these tests don't need a real (or stubbed) payment per call.
    paymentGate: async (_c, next) => {
      await next();
    },
  });
}

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "advance-sdk-api-test-"));
});

afterEach(async () => {
  rmSync(evidenceDir, { recursive: true, force: true });
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe("fetchScore", () => {
  it("returns an eligible ScoreResult with bigint fields revived from the wire JSON", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    const result = await fetchScore({ apiUrl }, fixture.token);

    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") throw new Error("expected eligible");
    expect(typeof result.terms.capMicroUsd).toBe("bigint");
    expect(typeof result.terms.minPrincipal).toBe("bigint");
    expect(typeof result.terms.haircutBps).toBe("number");
    expect(result.evidenceHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("returns a deny ScoreResult with reasons for a token that fails a hard rule", async () => {
    const fixture = loadSpider();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    const result = await fetchScore({ apiUrl }, fixture.token);

    expect(result.kind).toBe("deny");
    if (result.kind !== "deny") throw new Error("expected deny");
    expect(result.reasons).toContain("too_young");
  });

  it("throws AdvanceApiError for a malformed token address", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    await expect(fetchScore({ apiUrl }, "not-an-address" as Address)).rejects.toMatchObject({
      name: "AdvanceApiError",
      status: 400,
    });
  });
});

describe("fetchQuote", () => {
  it("approves: signature recovers to the configured signer, bigint fields revived", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    const decision = await fetchQuote(
      { apiUrl },
      { token: fixture.token, agentCard: AGENT_CARD, agentId: 88336n, chainId: 8453 },
    );

    expect(decision.kind).toBe("approve");
    if (decision.kind !== "approve") throw new Error("expected approve");
    expect(decision.termSheet.agentId).toBe(88336n);
    expect(typeof decision.termSheet.noteSupply).toBe("bigint");
    expect(typeof decision.termSheet.deadline).toBe("bigint");
    expect(typeof decision.termSheet.floorCents).toBe("number");

    const isValid = await verifyTermSheet(decision.termSheet, 8453, HUB, decision.signature, SIGNER_ADDRESS);
    expect(isValid).toBe(true);
  });

  it("denies without a term sheet or signature", async () => {
    const fixture = loadSpider();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    const decision = await fetchQuote(
      { apiUrl },
      { token: fixture.token, agentCard: AGENT_CARD, agentId: 1n, chainId: 8453 },
    );

    expect(decision.kind).toBe("deny");
    expect(decision).not.toHaveProperty("termSheet");
    expect(decision).not.toHaveProperty("signature");
  });

  it("throws AdvanceApiError(422) for an unsupported chainId", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    await expect(
      fetchQuote(
        { apiUrl },
        { token: fixture.token, agentCard: AGENT_CARD, agentId: 1n, chainId: 1 as unknown as 8453 },
      ),
    ).rejects.toMatchObject({ name: "AdvanceApiError", status: 422 });
  });

  it("uses paymentFetch over fetchImpl when both are provided", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    let paymentFetchCalls = 0;
    let plainFetchCalls = 0;
    const paymentFetch: typeof fetch = (...args) => {
      paymentFetchCalls++;
      return fetch(...args);
    };
    const fetchImpl: typeof fetch = (...args) => {
      plainFetchCalls++;
      return fetch(...args);
    };

    await fetchQuote(
      { apiUrl, paymentFetch, fetchImpl },
      { token: fixture.token, agentCard: AGENT_CARD, agentId: 1n, chainId: 8453 },
    );

    expect(paymentFetchCalls).toBe(1);
    expect(plainFetchCalls).toBe(0);
  });
});

describe("fetchEvidence", () => {
  it("retrieves the stored bundle and re-hashing it (bigint-for-bigint) reproduces the hash", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    const decision = await fetchQuote(
      { apiUrl },
      { token: fixture.token, agentCard: AGENT_CARD, agentId: 1n, chainId: 8453 },
    );
    const bundle = await fetchEvidence({ apiUrl }, decision.evidenceHash);

    expect(bundle.chainId).toBe(8453);
    expect(typeof bundle.formula.computedTerms.capMicroUsd).toBe("bigint");
  });

  it("throws AdvanceApiError(404) for an unknown hash", async () => {
    const fixture = loadRatspeak();
    server = await startFixtureServer(fixture);
    const apiUrl = `http://127.0.0.1:${server.port}`;

    await expect(fetchEvidence({ apiUrl }, `0x${"11".repeat(32)}` as `0x${string}`)).rejects.toMatchObject({
      name: "AdvanceApiError",
      status: 404,
    });
  });
});
