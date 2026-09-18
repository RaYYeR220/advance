import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chainAddresses,
  createFixtureBankrClient,
  createFixtureChainOps,
  type BankrClient,
  type BankrTokenFeesResponse,
  type ChainFixture,
} from "@advance/core";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createApp } from "../src/server.js";
import type { UnderwriterConfig } from "../src/config.js";
import { networkForChain, QUOTE_PRICE_ATOMIC_USDC } from "../src/payment.js";
import { startAnvilFork, type AnvilFork } from "./helpers/anvil-fork.js";
import { createInProcessFacilitator } from "./helpers/in-process-facilitator.js";

const HUB: Address = "0x00000000000000000000000000000000000A11CE";
const TEST_PRIVATE_KEY = "0x25c1a68a978b06379aa93931b26bef58b77c5fb7c64fd4bd5c93f490c085109c" as const;
const AGENT_CARD: Address = "0x1234567890123456789012345678901234567890";
const UNDERWRITER_PAYTO: Address = "0x2222222222222222222222222222222222222222";

const MAINNET_CHAIN_ID = 8453;
const DEMO_CHAIN_ID = 84532;
const MAINNET_NETWORK = networkForChain(MAINNET_CHAIN_ID);
const DEMO_NETWORK = networkForChain(DEMO_CHAIN_ID);
const MAINNET_USDC = chainAddresses(MAINNET_CHAIN_ID).usdc;
const DEMO_USDC = chainAddresses(DEMO_CHAIN_ID).usdc;

const FIXTURES_ROOT = resolve(import.meta.dirname, "../../../packages/core/test/fixtures");

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = join(FIXTURES_ROOT, slug, `${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function latestTimestampOf(chain: ChainFixture): number {
  return Math.max(...Object.values(chain.calls.blocks).map(Number));
}

/** Mainnet, always-approves fixture (same one `test/api.test.ts` uses) — used only by the
 * offline/no-network describe block below, where nothing ever actually settles on any
 * real chain (the facilitator is a stub whose `verify`/`settle` are never reached), so the
 * fixture's own chain id just needs to be internally consistent, not the demo chain. */
function loadRatspeak() {
  const chain = loadFixture<ChainFixture>("ratspeak", "chain");
  const bankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
  return { chain, bankr, token: chain.token as Address, now: latestTimestampOf(chain) };
}

/** The one real recorded Base Sepolia fixture in this repo (`@advance/core`'s own
 * `engine.test.ts` uses it the same way): a genuine just-launched Sepolia pool discovered
 * via Airlock alone, with no Bankr data (Bankr has no Sepolia coverage) and no trailing
 * revenue yet, so `underwrite` denies it `too_young`. Real recorded data, not fabricated
 * to force an approve — see the payment test below for why that's the honest choice. */
function loadSepoliaTest() {
  const chain = loadFixture<ChainFixture>("sepolia-test", "chain");
  return { chain, token: chain.token as Address, now: latestTimestampOf(chain) };
}

function unreachableBankr(): BankrClient {
  return {
    async getTokenFees(token) {
      throw new Error(`bankr unexpectedly called for ${token}`);
    },
  };
}

function testConfig(overrides: Partial<UnderwriterConfig> = {}, evidenceDir: string): UnderwriterConfig {
  return {
    CHAIN_ID: MAINNET_CHAIN_ID,
    BASE_RPC_URL: "https://rpc.invalid/base",
    BASE_SEPOLIA_RPC_URL: "https://rpc.invalid/base-sepolia",
    UNDERWRITER_PRIVATE_KEY: TEST_PRIVATE_KEY,
    ADVANCE_HUB: HUB,
    LLM_BASE_URL: "https://llm.invalid",
    LLM_MODEL: "test-model",
    EVIDENCE_DIR: evidenceDir,
    NETWORK: "mainnet",
    UNDERWRITER_PAYTO,
    X402_FACILITATOR_URL: "https://facilitator.invalid",
    TRUST_PROXY: false,
    ...overrides,
  };
}

/**
 * A facilitator double that never touches the network: `getSupported` resolves
 * synchronously with a plausible capability list, and `verify`/`settle` throw if ever
 * reached (the offline tests below never pay, so they never should be).
 */
function offlineFacilitatorStub(network: `eip155:${number}`): FacilitatorClient {
  return {
    async getSupported(): Promise<SupportedResponse> {
      return { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} };
    },
    async verify(): Promise<never> {
      throw new Error("offlineFacilitatorStub.verify should not be reached in these tests");
    },
    async settle(): Promise<never> {
      throw new Error("offlineFacilitatorStub.settle should not be reached in these tests");
    },
  };
}

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "advance-underwriter-payment-test-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe("POST /v1/quote: x402 gate (offline, no network)", () => {
  function buildApp() {
    const fixture = loadRatspeak();
    return createApp(testConfig({}, evidenceDir), {
      chain: createFixtureChainOps(fixture.chain),
      bankr: createFixtureBankrClient(fixture.bankr),
      now: () => fixture.now,
      facilitatorClient: offlineFacilitatorStub(MAINNET_NETWORK),
    });
  }

  it("returns 402 with the correct payment requirements when unpaid (asset, network, payTo, amount, scheme)", async () => {
    const app = buildApp();
    const fixture = loadRatspeak();

    const res = await app.request("/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: MAINNET_CHAIN_ID }),
    });

    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const paymentRequired = decodePaymentRequiredHeader(header!);
    expect(paymentRequired.accepts).toHaveLength(1);
    const accept = paymentRequired.accepts[0]!;
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe(MAINNET_NETWORK);
    expect(accept.payTo).toBe(UNDERWRITER_PAYTO);
    expect(accept.asset).toBe(MAINNET_USDC);
    expect(accept.amount).toBe(QUOTE_PRICE_ATOMIC_USDC);
  });

  it("GET /v1/score/:token stays free even with a real x402 gate wired to /v1/quote", async () => {
    const app = buildApp();
    const fixture = loadRatspeak();

    const res = await app.request(`/v1/score/${fixture.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("eligible");
  });

  it("GET /health is unaffected by the payment gate", async () => {
    const app = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/quote: internal-key bypass (Bankr x402 Cloud forwarding)", () => {
  const INTERNAL_KEY = "test-internal-key-do-not-reuse";

  function buildApp(internalKey: string | undefined) {
    const fixture = loadRatspeak();
    return createApp(testConfig({ UNDERWRITER_INTERNAL_KEY: internalKey }, evidenceDir), {
      chain: createFixtureChainOps(fixture.chain),
      bankr: createFixtureBankrClient(fixture.bankr),
      now: () => fixture.now,
      facilitatorClient: offlineFacilitatorStub(MAINNET_NETWORK),
    });
  }

  function quoteRequest(headers: Record<string, string> = {}) {
    const fixture = loadRatspeak();
    return { fixture, init: { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: MAINNET_CHAIN_ID }) } };
  }

  it("with no key configured, the header is never consulted — payment is still required", async () => {
    const app = buildApp(undefined);
    const { init } = quoteRequest({ "x-internal-key": "anything" });
    const res = await app.request("/v1/quote", init);
    expect(res.status).toBe(402);
  });

  it("with a key configured, the exact matching header skips the x402 gate", async () => {
    const app = buildApp(INTERNAL_KEY);
    const { init } = quoteRequest({ "x-internal-key": INTERNAL_KEY });
    const res = await app.request("/v1/quote", init);
    expect(res.status).toBe(200);
  });

  it("with a key configured, a missing or wrong header still requires payment", async () => {
    const app = buildApp(INTERNAL_KEY);

    const missing = await app.request("/v1/quote", quoteRequest().init);
    expect(missing.status).toBe(402);

    const wrong = await app.request("/v1/quote", quoteRequest({ "x-internal-key": "not-the-key" }).init);
    expect(wrong.status).toBe(402);
  });
});

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const describeIfFork = BASE_SEPOLIA_RPC_URL ? describe : describe.skip;

describeIfFork("POST /v1/quote: paid path (anvil fork of Base Sepolia + in-process facilitator)", () => {
  let fork: AnvilFork;
  let payer: ReturnType<typeof privateKeyToAccount>;
  let relayer: ReturnType<typeof privateKeyToAccount>;

  beforeAll(async () => {
    fork = await startAnvilFork(BASE_SEPOLIA_RPC_URL!, 8558);
    payer = privateKeyToAccount(generatePrivateKey());
    relayer = privateKeyToAccount(generatePrivateKey());
    await fork.setBalance(relayer.address, 10n ** 18n);
    await fork.setUsdcBalance(DEMO_USDC, payer.address, 1_000_000n); // 1 USDC (6 decimals)
  }, 30_000);

  afterAll(async () => {
    await fork?.stop();
  });

  function payingFetch(app: ReturnType<typeof createApp>) {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: payer });
    return wrapFetchWithPayment(app.request.bind(app) as unknown as typeof fetch, client);
  }

  function buildDemoApp() {
    const facilitatorClient = createInProcessFacilitator({ rpcUrl: fork.rpcUrl, network: DEMO_NETWORK, relayer });
    return createApp(testConfig({ CHAIN_ID: DEMO_CHAIN_ID, NETWORK: "demo" }, evidenceDir), {
      chain: createFixtureChainOps(loadSepoliaTest().chain),
      bankr: unreachableBankr(), // Bankr has no Sepolia data; must never be called
      now: () => loadSepoliaTest().now,
      facilitatorClient,
    });
  }

  it(
    "pays 0.05 USDC on-chain and returns 200 with the engine's real decision",
    async () => {
      const fixture = loadSepoliaTest();
      const app = buildDemoApp();

      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(fork.rpcUrl) });
      const balanceOf = (address: Address) =>
        publicClient.readContract({ address: DEMO_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });

      const payeeBefore = await balanceOf(UNDERWRITER_PAYTO);
      const payerBefore = await balanceOf(payer.address);

      const fetchWithPay = payingFetch(app);
      const res = await fetchWithPay(new URL("/v1/quote", "http://underwriter.local"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: DEMO_CHAIN_ID }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // The real recorded Sepolia fixture is a just-launched pool with no trailing revenue
      // yet — the engine honestly denies it (`too_young`), same as `@advance/core`'s own
      // `engine.test.ts` assertion for this exact fixture. This test's job is proving the
      // payment settled for real (checked below), not forcing a specific business outcome.
      expect(body.kind).toBe("deny");
      expect(body.reasons).toContain("too_young");

      const payeeAfter = await balanceOf(UNDERWRITER_PAYTO);
      const payerAfter = await balanceOf(payer.address);
      expect(payeeAfter - payeeBefore).toBe(BigInt(QUOTE_PRICE_ATOMIC_USDC));
      expect(payerBefore - payerAfter).toBe(BigInt(QUOTE_PRICE_ATOMIC_USDC));
    },
    30_000,
  );

  it(
    "402 unpaid, 200 once paid, on the same live payTo/asset/network the gate advertises",
    async () => {
      const fixture = loadSepoliaTest();
      const app = buildDemoApp();

      const unpaid = await app.request("/v1/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: DEMO_CHAIN_ID }),
      });
      expect(unpaid.status).toBe(402);
      const paymentRequired = decodePaymentRequiredHeader(unpaid.headers.get("PAYMENT-REQUIRED")!);
      const accept = paymentRequired.accepts[0]!;
      expect(accept.network).toBe(DEMO_NETWORK);
      expect(accept.asset).toBe(DEMO_USDC);
      expect(accept.payTo).toBe(UNDERWRITER_PAYTO);
      expect(accept.amount).toBe(QUOTE_PRICE_ATOMIC_USDC);

      const fetchWithPay = payingFetch(app);
      const paid = await fetchWithPay(new URL("/v1/quote", "http://underwriter.local"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: fixture.token, agentCard: AGENT_CARD, agentId: "1", chainId: DEMO_CHAIN_ID }),
      });
      expect(paid.status).toBe(200);
    },
    30_000,
  );
});
