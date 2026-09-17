import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { loadConfig, networkForChain, usdcAddressForChain, type AgentsConfig } from "../src/config.js";
import { createServiceApp, MAX_CHAT_BODY_BYTES, REDTEAM_PAYLOADS } from "../src/services/x402-llm.js";
import { startAnvilFork, type AnvilFork } from "./helpers/anvil-fork.js";
import { createInProcessFacilitator } from "./helpers/in-process-facilitator.js";
import { startStubLlm, STUB_COMPLETION_BODY } from "./helpers/stub-llm.js";

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const describeIfFork = BASE_SEPOLIA_RPC_URL ? describe : describe.skip;

describeIfFork("x402-llm service (anvil fork + in-process facilitator)", () => {
  const CHAIN_ID = 84532;
  const USDC = usdcAddressForChain(CHAIN_ID);
  const NETWORK = networkForChain(CHAIN_ID);
  const SERVICE_PAYTO = "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0" as const;

  let fork: AnvilFork;
  let stubLlm: { url: string; close(): Promise<void> };
  let payer: ReturnType<typeof privateKeyToAccount>;
  let relayer: ReturnType<typeof privateKeyToAccount>;
  let baseConfig: AgentsConfig;

  beforeAll(async () => {
    fork = await startAnvilFork(BASE_SEPOLIA_RPC_URL!, 8549);
    stubLlm = startStubLlm();

    payer = privateKeyToAccount(generatePrivateKey());
    relayer = privateKeyToAccount(generatePrivateKey());
    await fork.setBalance(relayer.address, 10n ** 18n);
    await fork.setUsdcBalance(USDC, payer.address, 1_000_000n);

    baseConfig = loadConfig({
      LLM_BASE_URL: stubLlm.url,
      SERVICE_PAYTO,
      CHAIN_ID: String(CHAIN_ID),
    });
  }, 30_000);

  afterAll(async () => {
    await stubLlm?.close();
    await fork?.stop();
  });

  function payingFetch() {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: payer });
    return wrapFetchWithPayment(app.request.bind(app) as unknown as typeof fetch, client);
  }

  let app: ReturnType<typeof createServiceApp>;

  beforeAll(() => {
    const facilitatorClient = createInProcessFacilitator({
      rpcUrl: fork.rpcUrl,
      network: NETWORK,
      relayer,
    });
    app = createServiceApp(baseConfig, { facilitatorClient });
  });

  it("returns 402 with the correct payment requirements when unpaid", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const paymentRequired = decodePaymentRequiredHeader(header!);
    expect(paymentRequired.accepts).toHaveLength(1);
    const accept = paymentRequired.accepts[0]!;
    expect(accept.network).toBe(NETWORK);
    expect(accept.payTo).toBe(SERVICE_PAYTO);
    expect(accept.asset).toBe(USDC);
    expect(accept.amount).toBe("1000");
  });

  it("returns 402 for an unpaid GET /v1/data/:topic request", async () => {
    const res = await app.request("/v1/data/prompt-injection");
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("proxies to the upstream and returns 200 once paid", async () => {
    const fetchWithPay = payingFetch();
    const res = await fetchWithPay(new URL("/v1/chat/completions", "http://service.local"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(STUB_COMPLETION_BODY);
  });

  it("/v1/data/:topic omits the red-team payload when REDTEAM is off", async () => {
    const fetchWithPay = payingFetch();
    const res = await fetchWithPay(new URL("/v1/data/prompt-injection", "http://service.local"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redteam: boolean; content: string };
    expect(body.redteam).toBe(false);
    expect(body.content).not.toContain(REDTEAM_PAYLOADS["prompt-injection"]);
  });

  it("/v1/data/:topic serves the red-team payload only when REDTEAM=1", async () => {
    const facilitatorClient = createInProcessFacilitator({ rpcUrl: fork.rpcUrl, network: NETWORK, relayer });
    const redteamConfig = loadConfig({
      LLM_BASE_URL: stubLlm.url,
      SERVICE_PAYTO,
      CHAIN_ID: String(CHAIN_ID),
      REDTEAM: "1",
    });
    const redteamApp = createServiceApp(redteamConfig, { facilitatorClient });

    const client = new x402Client();
    registerExactEvmScheme(client, { signer: payer });
    const fetchWithPay = wrapFetchWithPayment(redteamApp.request.bind(redteamApp) as unknown as typeof fetch, client);

    const res = await fetchWithPay(new URL("/v1/data/prompt-injection", "http://service.local"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redteam: boolean; content: string };
    expect(body.redteam).toBe(true);
    expect(body.content).toBe(REDTEAM_PAYLOADS["prompt-injection"]);
  });

  it("returns a controlled 502 when the upstream LLM request fails, without leaking upstream error details", async () => {
    const facilitatorClient = createInProcessFacilitator({ rpcUrl: fork.rpcUrl, network: NETWORK, relayer });
    const secretDetail = "ECONNREFUSED internal-upstream.example.internal:9999";
    const throwingFetch = (async () => {
      throw new Error(secretDetail);
    }) as unknown as typeof fetch;
    const failingApp = createServiceApp(baseConfig, { facilitatorClient, fetchImpl: throwingFetch });

    const client = new x402Client();
    registerExactEvmScheme(client, { signer: payer });
    const fetchWithPay = wrapFetchWithPayment(failingApp.request.bind(failingApp) as unknown as typeof fetch, client);

    const res = await fetchWithPay(new URL("/v1/chat/completions", "http://service.local"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(secretDetail);
    expect(text).not.toContain("ECONNREFUSED");
    expect(JSON.parse(text)).toEqual({ error: "upstream LLM request failed" });
  });
});

/**
 * A facilitator double that never touches the network: `getSupported`
 * resolves synchronously with a plausible capability list, and
 * `verify`/`settle` throw if ever reached (none of the tests below pay, so
 * they never should be).
 */
function offlineFacilitatorStub(network: `eip155:${number}`) {
  return {
    async getSupported() {
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

describe("x402-llm service (config/body validation, no network)", () => {
  const config = loadConfig({
    LLM_BASE_URL: "https://example.invalid",
    SERVICE_PAYTO: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
    CHAIN_ID: "84532",
  });
  const facilitatorClient = offlineFacilitatorStub("eip155:84532");

  it("rejects a chat-completions body over 256KB with 413 before payment is charged", async () => {
    const app = createServiceApp(config, { facilitatorClient });
    const oversizedBody = "x".repeat(MAX_CHAT_BODY_BYTES + 1);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
  });

  it("accepts a chat-completions body at or under the 256KB limit (still requires payment)", async () => {
    const app = createServiceApp(config, { facilitatorClient });
    const okBody = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1000) }] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: okBody,
    });
    // Not rejected for size — falls through to the payment requirement (402), not 413.
    expect(res.status).toBe(402);
  });

  it("refuses to construct the service against Base mainnet unless ALLOW_MAINNET_SERVICE=1", () => {
    const mainnetConfig = loadConfig({
      LLM_BASE_URL: "https://example.invalid",
      SERVICE_PAYTO: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
      CHAIN_ID: "8453",
    });
    expect(() => createServiceApp(mainnetConfig, { facilitatorClient: offlineFacilitatorStub("eip155:8453") })).toThrow(
      /mainnet/i,
    );

    const allowedMainnetConfig = loadConfig({
      LLM_BASE_URL: "https://example.invalid",
      SERVICE_PAYTO: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
      CHAIN_ID: "8453",
      ALLOW_MAINNET_SERVICE: "1",
    });
    expect(() =>
      createServiceApp(allowedMainnetConfig, { facilitatorClient: offlineFacilitatorStub("eip155:8453") }),
    ).not.toThrow();
  });
});
