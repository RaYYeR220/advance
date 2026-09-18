import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { createCardFetch, isGatewayRefusalResponse } from "../../src/card/gateway.js";
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
    frozen?: boolean;
    failStaticReads?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const usdc = overrides.usdc ?? USDC;
  const client = {
    chain: { id: 8453 },
    async readContract(args: { functionName: string }) {
      calls.push(args.functionName);
      // balanceOf/frozen are mutable and read fresh every request, so the fake
      // never gates them behind failStaticReads - a card_config_unavailable
      // failure is about the immutable params below, not these.
      if (args.functionName === "balanceOf") {
        return overrides.balance ?? 1_000_000n;
      }
      if (args.functionName === "frozen") {
        return overrides.frozen ?? false;
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

function requirementFor(payTo: Address, overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC,
    amount: "1000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

function buildPaymentRequired(payTo: Address, amount = "1000", overrides: Partial<PaymentRequirements> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://service.example/resource" },
    accepts: [requirementFor(payTo, { amount, ...overrides })],
  };
}

function buildMultiPaymentRequired(...requirements: PaymentRequirements[]): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://service.example/resource" },
    accepts: requirements,
  };
}

/** A request without a PAYMENT-SIGNATURE header gets the unpaid 402; one that
 * carries it gets a settled response (`settle`, `settleStatus`). Reusable across
 * multiple pay rounds on the same gateway instance, which is what makes the
 * static-params caching test meaningful. */
function fakeFetchSequence(paymentRequired: PaymentRequired, settle: SettleResponse, settleStatus = 200) {
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
    return new Response(JSON.stringify({ ok: settle.success }), {
      status: settleStatus,
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
    expect(isGatewayRefusalResponse(res)).toBe(true);
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

  it("refuses every option when the card is frozen, before any signature is requested", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const { fetchImpl, requests } = fakeFetchSequence(pr, { success: true, transaction: "0x", network: "eip155:8453" });
    const { client: chain } = fakePublicClient({ payees: [PAYEE], frozen: true });
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ refused: true, reason: "card_frozen" });
    expect(requests).toHaveLength(1);
    expect(keys.calls).toHaveLength(0);
    expect(appended[0]?.data).toMatchObject({ reason: "card_frozen" });
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
    expect(isGatewayRefusalResponse(res)).toBe(false);
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

  it("caches the card's static params (payees/perCallCap/maxAuthWindow/usdc) across requests on the same gateway, but re-reads balance/frozen every time", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const { fetchImpl } = fakeFetchSequence(pr, { success: true, transaction: "0x1", network: "eip155:8453" });
    const { client: chain, calls: chainCalls } = fakePublicClient({ payees: [PAYEE] });
    const { sink: events } = fakeEvents();
    const keys = fakeKeys();

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    await cardFetch("https://service.example/resource");
    await cardFetch("https://service.example/resource");

    const staticReads = chainCalls.filter((c) => c !== "balanceOf" && c !== "frozen");
    const balanceReads = chainCalls.filter((c) => c === "balanceOf");
    const frozenReads = chainCalls.filter((c) => c === "frozen");
    // payees, perCallCap, maxAuthWindow, usdc - read once total across both requests.
    expect(staticReads).toHaveLength(4);
    // balanceOf and frozen are read fresh on every request (both are mutable).
    expect(balanceReads).toHaveLength(2);
    expect(frozenReads).toHaveLength(2);
  });

  describe("multi-option 402 responses", () => {
    it("refuses when the only scheme/network-selectable option fails precheck, even though a non-selectable option looks fine", async () => {
      // Our client only ever registers the "exact" scheme, so x402 itself filters
      // the "upto" entry out before this gateway's selector/precheck ever sees it -
      // it must not be treated as an acceptable fallback.
      const pr = buildMultiPaymentRequired(
        requirementFor(PAYEE, { scheme: "upto" }),
        requirementFor(EVIL),
      );
      const { fetchImpl, requests } = fakeFetchSequence(pr, { success: true, transaction: "0x", network: "eip155:8453" });
      const { client: chain } = fakePublicClient({ payees: [PAYEE] });
      const { sink: events, appended } = fakeEvents();
      const keys = fakeKeys();

      const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
      const res = await cardFetch("https://service.example/resource");

      expect(res.status).toBe(402);
      expect(isGatewayRefusalResponse(res)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(keys.calls).toHaveLength(0);
      expect(appended).toHaveLength(1);
      expect(appended[0]?.kind).toEqual("refusal");
      expect(appended[0]?.data).toMatchObject({ reason: "payee_not_allowlisted", payTo: EVIL, amount: "1000" });
    });

    it("signs and settles a later valid option when an earlier selectable option fails precheck, and reports the option actually signed", async () => {
      const pr = buildMultiPaymentRequired(requirementFor(EVIL), requirementFor(PAYEE, { amount: "2000" }));
      const settle: SettleResponse = { success: true, transaction: "0xlater", network: "eip155:8453" };
      const { fetchImpl, requests } = fakeFetchSequence(pr, settle);
      const { client: chain } = fakePublicClient({ payees: [PAYEE], perCallCap: 10_000n });
      const { sink: events, appended } = fakeEvents();
      const keys = fakeKeys("0xownersig" as Hex);

      const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
      const res = await cardFetch("https://service.example/resource");

      expect(res.status).toBe(200);
      expect(requests).toHaveLength(2);
      expect(keys.calls).toHaveLength(1);
      expect(appended.some((e) => e.kind === "refusal")).toBe(false);
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({ kind: "receipt", data: { payTo: PAYEE, amount: "2000" } });
    });

    it("single-option behavior is unchanged: a lone failing option still refuses with its own specific reason", async () => {
      const pr = buildMultiPaymentRequired(requirementFor(EVIL));
      const { fetchImpl, requests } = fakeFetchSequence(pr, { success: true, transaction: "0x", network: "eip155:8453" });
      const { client: chain } = fakePublicClient({ payees: [PAYEE] });
      const { sink: events, appended } = fakeEvents();
      const keys = fakeKeys();

      const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
      const res = await cardFetch("https://service.example/resource");

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ refused: true, reason: "payee_not_allowlisted" });
      expect(requests).toHaveLength(1);
      expect(keys.calls).toHaveLength(0);
    });
  });

  it("catches a throw from signing after precheck passes, and returns a synthetic refusal instead of rejecting", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const { fetchImpl, requests } = fakeFetchSequence(pr, { success: true, transaction: "0x", network: "eip155:8453" });
    const { client: chain } = fakePublicClient({ payees: [PAYEE] });
    const { sink: events, appended } = fakeEvents();
    const keys = {
      async signTypedData(): Promise<Hex> {
        throw new Error("dynamic unavailable");
      },
    };

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.refused).toBe(true);
    expect(isGatewayRefusalResponse(res)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(appended[0]?.data).toMatchObject({ reason: "payment_creation_failed" });
  });

  it("logs a settlement_failed event (not a receipt) when the facilitator rejects settlement after precheck passes", async () => {
    const pr = buildPaymentRequired(PAYEE);
    const settle: SettleResponse = {
      success: false,
      transaction: "",
      network: "eip155:8453",
      errorReason: "invalid_exact_evm_nonce_already_used",
    };
    const { fetchImpl, requests } = fakeFetchSequence(pr, settle, 402);
    const { client: chain } = fakePublicClient({ payees: [PAYEE] });
    const { sink: events, appended } = fakeEvents();
    const keys = fakeKeys("0xownersig" as Hex);

    const cardFetch = createCardFetch({ agent: "agent-a", card: CARD, keys, events, chain, fetchImpl });
    const res = await cardFetch("https://service.example/resource");

    expect(res.status).toBe(402);
    expect(isGatewayRefusalResponse(res)).toBe(false); // a real response from the wrapped fetch, not synthesized
    expect(requests).toHaveLength(2);
    expect(keys.calls).toHaveLength(1); // precheck passed, so signing did happen
    expect(appended.some((e) => e.kind === "receipt")).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      kind: "settlement_failed",
      data: { payTo: PAYEE, amount: "1000", errorReason: "invalid_exact_evm_nonce_already_used" },
    });
  });
});
