import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { createCardFetch } from "../../src/card/gateway.js";
import type { AgentEvent, EventSink } from "../../src/events.js";
import type { EvmTypedData } from "../../src/dynamic.js";

const CARD = "0x6d11186eb5aaec25a9eb57308ea26a757138b1be" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const PAYEE = "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0" as Address;
const EVIL = "0x000000000000000000000000000000000000dEaD" as Address;

function fakeEvents() {
  const appended: Array<Omit<AgentEvent, "ts"> & { ts?: number }> = [];
  const sink: EventSink = {
    async append(event) {
      appended.push(event);
    },
  };
  return { sink, appended };
}

function fakeKeys(signature: Hex = "0xownersignature") {
  const calls: Array<{ label: string; typedData: EvmTypedData }> = [];
  return {
    calls,
    async signTypedData(label: string, typedData: EvmTypedData): Promise<Hex> {
      calls.push({ label, typedData });
      return signature;
    },
  };
}

function fakePublicClient(
  overrides: {
    payees?: Address[];
    perCallCap?: bigint;
    maxAuthWindow?: bigint;
    usdc?: Address;
    balance?: bigint;
    failStaticReads?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const usdc = overrides.usdc ?? USDC;
  const client = {
    chain: { id: 8453 },
    async readContract(args: { functionName: string }) {
      calls.push(args.functionName);
      if (args.functionName === "balanceOf") {
        return overrides.balance ?? 1_000_000n;
      }
      if (overrides.failStaticReads) {
        throw new Error("rpc unavailable");
      }
      switch (args.functionName) {
        case "payees":
          return overrides.payees ?? [PAYEE];
        case "perCallCap":
          return overrides.perCallCap ?? 10_000n;
        case "maxAuthWindow":
          return overrides.maxAuthWindow ?? 300n;
        case "usdc":
          return usdc;
        default:
          throw new Error(`fakePublicClient: unexpected functionName "${args.functionName}"`);
      }
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

function buildPaymentRequired(payTo: Address, amount = "1000", overrides: Partial<PaymentRequirements> = {}): PaymentRequired {
  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
  return {
    x402Version: 2,
    resource: { url: "https://service.example/resource" },
    accepts: [requirement],
  };
}

/** A request without a PAYMENT-SIGNATURE header gets the unpaid 402; one that
 * carries it gets a settled 200. Reusable across multiple pay rounds on the same
 * gateway instance, which is what makes the static-params caching test meaningful. */
function fakeFetchSequence(paymentRequired: PaymentRequired, settle: SettleResponse) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      return new Response(null, {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("createCardFetch", () => {
  it("passes a non-402 response straight through, with no on-chain reads and no signature request", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const { client: chain, calls: chainCalls } = fakePublicClient();
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(200);
    expect(chainCalls).toHaveLength(0);
    expect(keys.calls).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  it("refuses a non-allowlisted payee before ever requesting a signature, and never retries with payment", async () => {
    const pr = buildPaymentRequired(EVIL);
    const settle: SettleResponse = { success: true, transaction: "0xshouldneverhappen", network: "eip155:8453" };
    const { fetchImpl, requests } = fakeFetchSequence(pr, settle);
    const { client: chain } = fakePublicClient({ payees: [PAYEE] });
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ refused: true, reason: "payee_not_allowlisted" });
    expect(requests).toHaveLength(1);
    expect(keys.calls).toHaveLength(0);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      agent: "agent-a",
      kind: "refusal",
      data: { layer: "gateway", reason: "payee_not_allowlisted", payTo: EVIL, amount: "1000" },
    });
  });

  it("refuses an amount over the per-call cap before ever requesting a signature", async () => {
    const pr = buildPaymentRequired(PAYEE, "20000");
    const { fetchImpl, requests } = fakeFetchSequence(pr, { success: true, transaction: "0x", network: "eip155:8453" });
    const { client: chain } = fakePublicClient({ payees: [PAYEE], perCallCap: 10_000n });
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ refused: true, reason: "amount_exceeds_per_call_cap" });
    expect(requests).toHaveLength(1);
    expect(keys.calls).toHaveLength(0);
    expect(appended[0]?.data).toMatchObject({ reason: "amount_exceeds_per_call_cap" });
  });

  it("pays and returns the settled response when precheck passes, logging a receipt with the settlement txHash", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const settle: SettleResponse = { success: true, transaction: "0xabc123", network: "eip155:8453", payer: CARD };
    const { fetchImpl, requests } = fakeFetchSequence(pr, settle);
    const { client: chain } = fakePublicClient({ payees: [PAYEE] });
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys("0xownersig" as Hex);

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.has("PAYMENT-SIGNATURE")).toBe(true);

    expect(keys.calls).toHaveLength(1);
    expect(keys.calls[0]!.label).toEqual("agent-a");
    expect(keys.calls[0]!.typedData.primaryType).toEqual("TransferWithAuthorization");

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      agent: "agent-a",
      kind: "receipt",
      txHash: "0xabc123",
      data: { payTo: PAYEE, amount: "1000", network: "eip155:8453", asset: USDC },
    });
  });

  it("fails closed (refuses) when the card's on-chain config can't be read", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const { fetchImpl, requests } = fakeFetchSequence(pr, { success: true, transaction: "0x", network: "eip155:8453" });
    const { client: chain } = fakePublicClient({ failStaticReads: true });
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ refused: true, reason: "card_config_unavailable" });
    expect(requests).toHaveLength(1);
    expect(keys.calls).toHaveLength(0);
    expect(appended[0]?.data).toMatchObject({ reason: "card_config_unavailable" });
  });

  it("fails closed (refuses) when the 402 response carries no parseable payment requirement", async () => {
    const fetchImpl = (async () => new Response("not json and no header", { status: 402 })) as typeof fetch;
    const { client: chain } = fakePublicClient();
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ refused: true, reason: "malformed_payment_required" });
    expect(keys.calls).toHaveLength(0);
    expect(appended[0]?.data).toMatchObject({ reason: "malformed_payment_required" });
  });

  it("caches the card's static params (payees/perCallCap/maxAuthWindow/usdc) across requests on the same gateway, but re-reads the balance every time", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const { fetchImpl } = fakeFetchSequence(pr, { success: true, transaction: "0x1", network: "eip155:8453" });
    const { client: chain, calls: chainCalls } = fakePublicClient({ payees: [PAYEE] });
    const { sink: events } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    await cardFetch("https://service.example/resource");
    await cardFetch("https://service.example/resource");

    const staticReads = chainCalls.filter((c) => c !== "balanceOf");
    const balanceReads = chainCalls.filter((c) => c === "balanceOf");
    // payees, perCallCap, maxAuthWindow, usdc - read once total across both requests.
    expect(staticReads).toHaveLength(4);
    // balanceOf is read fresh on every request (spend changes it).
    expect(balanceReads).toHaveLength(2);
  });
});
