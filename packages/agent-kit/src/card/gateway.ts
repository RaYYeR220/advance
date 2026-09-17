import { erc20Abi, type Address, type PublicClient } from "viem";
import { agentCardAbi } from "@advance/core";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { DynamicKeys } from "../dynamic.js";
import type { EventSink } from "../events.js";
import { cardSigner, type CardSignerKeys } from "./signer.js";
import { precheck, type CardPolicyConfig } from "./policy.js";

export interface CreateCardFetchParams {
  /** Identifies the agent for events, and the {@link DynamicKeys} label whose
   * signatures verify against `AgentCard.owner()` for this card. */
  agent: string;
  /** The AgentCard this fetch spends from. */
  card: Address;
  /** Signs on behalf of the card owner (see {@link cardSigner}). */
  keys: CardSignerKeys;
  /** Refusals and receipts are appended here. */
  events: EventSink;
  /** A viem `PublicClient` constructed with an explicit `Chain` - both this
   * gateway's on-chain reads (`payees`/`perCallCap`/`maxAuthWindow`/`usdc`/balance)
   * and the x402 CAIP-2 network id (`eip155:<chain.id>`) come from it. Passing an
   * already-configured client (rather than a bare chain id) keeps this gateway
   * free of any built-in RPC default - tests point it at an anvil fork, nothing
   * here ever guesses an endpoint. */
  chain: PublicClient;
  /** Base fetch to wrap. Defaults to the global `fetch`; tests inject a fake. */
  fetchImpl?: typeof fetch;
}

interface StaticCardParams {
  payees: readonly Address[];
  perCallCap: bigint;
  maxAuthWindow: bigint;
  usdc: Address;
}

function refusalResponse(reason: string): Response {
  return new Response(JSON.stringify({ refused: true, reason }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Builds the agent's paying `fetch`: wraps a base `fetch` so that a 402 response is
 * answered by paying from `card`, and refuses before ever asking for a signature
 * when the payment falls outside `card`'s on-chain policy (network, asset, payee
 * allowlist, per-call cap, authorization window, available balance - see
 * {@link precheck}). A refusal never reaches the card owner key: it's logged as a
 * `refusal` event and this function synthesizes a `{refused:true, reason}` 402
 * response itself, without a network round trip to any facilitator.
 *
 * The card contract enforces every one of these rules again on-chain
 * (`AgentCard.isValidSignature`) - this is defense in depth and a fast, logged
 * refusal, not the only line of defense.
 */
export function createCardFetch(params: CreateCardFetchParams): typeof fetch {
  const { agent, card, keys, events, chain, fetchImpl = fetch } = params;

  const chainId = chain.chain?.id;
  if (chainId === undefined) {
    throw new Error("createCardFetch: chain (the viem PublicClient) must be constructed with an explicit Chain");
  }
  const network = `eip155:${chainId}` as Network;

  let staticParamsPromise: Promise<StaticCardParams> | undefined;

  /** `payees`/`perCallCap`/`maxAuthWindow`/`usdc` are immutable once the card is
   * deployed (set once in its constructor), so a successful read is cached for the
   * lifetime of this gateway. A failed read is never cached, so a transient RPC
   * hiccup doesn't wedge the gateway shut. */
  function loadStaticCardParams(): Promise<StaticCardParams> {
    if (!staticParamsPromise) {
      staticParamsPromise = Promise.all([
        chain.readContract({ address: card, abi: agentCardAbi, functionName: "payees" }),
        chain.readContract({ address: card, abi: agentCardAbi, functionName: "perCallCap" }),
        chain.readContract({ address: card, abi: agentCardAbi, functionName: "maxAuthWindow" }),
        chain.readContract({ address: card, abi: agentCardAbi, functionName: "usdc" }),
      ])
        .then(([payees, perCallCap, maxAuthWindow, usdc]) => ({ payees, perCallCap, maxAuthWindow, usdc }))
        .catch((err: unknown) => {
          staticParamsPromise = undefined;
          throw err;
        });
    }
    return staticParamsPromise;
  }

  async function loadCardPolicyConfig(): Promise<CardPolicyConfig> {
    const staticParams = await loadStaticCardParams();
    const usdcBalance = (await chain.readContract({
      address: staticParams.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [card],
    })) as bigint;
    return { network, ...staticParams, usdcBalance };
  }

  // Parsing (decoding the PAYMENT-REQUIRED header/body, encoding the payment
  // header, decoding the settlement result) never touches a registered scheme, so
  // it's done through an httpClient wrapping an unregistered client - built once,
  // synchronously, with no on-chain read and no signer. The signing client (which
  // needs the card's own `usdc()` address, only known after an on-chain read, and
  // wraps the real `cardSigner`) is built lazily and only reached once `precheck`
  // has already passed - an RPC hiccup or an off-policy request never gets past
  // this parser to touch the owner key.
  const parserHttpClient = new x402HTTPClient(new x402Client());

  let realClientPromise: Promise<x402Client> | undefined;
  function loadRealClient(): Promise<x402Client> {
    if (!realClientPromise) {
      realClientPromise = loadStaticCardParams().then((staticParams) => {
        const realSigner = cardSigner(card, agent, { keys, usdc: staticParams.usdc });
        const client = new x402Client();
        registerExactEvmScheme(client, { signer: realSigner, networks: [network] });
        return client;
      });
    }
    return realClientPromise;
  }

  return async function cardFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const clonedRequest = request.clone();
    const response = await fetchImpl(request);
    if (response.status !== 402) {
      return response;
    }

    let paymentRequired: PaymentRequired;
    try {
      const getHeader = (name: string) => response.headers.get(name);
      let body: unknown;
      try {
        const text = await response.text();
        if (text) body = JSON.parse(text);
      } catch {
        // no/invalid JSON body - fall through with an undefined body; a v2
        // resource server carries everything needed in the PAYMENT-REQUIRED header.
      }
      paymentRequired = parserHttpClient.getPaymentRequiredResponse(getHeader, body);
    } catch {
      await events.append({
        agent,
        kind: "refusal",
        data: { layer: "gateway", reason: "malformed_payment_required" },
      });
      return refusalResponse("malformed_payment_required");
    }

    const requirement: PaymentRequirements | undefined = paymentRequired.accepts[0];
    if (!requirement) {
      await events.append({
        agent,
        kind: "refusal",
        data: { layer: "gateway", reason: "no_payment_option" },
      });
      return refusalResponse("no_payment_option");
    }

    let cardConfig: CardPolicyConfig;
    try {
      cardConfig = await loadCardPolicyConfig();
    } catch {
      await events.append({
        agent,
        kind: "refusal",
        data: {
          layer: "gateway",
          reason: "card_config_unavailable",
          payTo: requirement.payTo,
          amount: requirement.amount,
        },
      });
      return refusalResponse("card_config_unavailable");
    }

    const decision = precheck(requirement, cardConfig);
    if (!decision.ok) {
      await events.append({
        agent,
        kind: "refusal",
        data: {
          layer: "gateway",
          reason: decision.reason,
          payTo: requirement.payTo,
          amount: requirement.amount,
        },
      });
      return refusalResponse(decision.reason);
    }

    const client = await loadRealClient();
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const paymentHeaders = parserHttpClient.encodePaymentSignatureHeader(paymentPayload);
    if (clonedRequest.headers.has("PAYMENT-SIGNATURE") || clonedRequest.headers.has("X-PAYMENT")) {
      throw new Error("createCardFetch: payment already attempted for this request");
    }
    for (const [key, value] of Object.entries(paymentHeaders)) {
      clonedRequest.headers.set(key, value);
    }

    const secondResponse = await fetchImpl(clonedRequest.clone());
    const settleResult = await parserHttpClient.processPaymentResult(
      paymentPayload,
      (name) => secondResponse.headers.get(name),
      secondResponse.status,
    );

    if (settleResult.settleResponse?.success) {
      await events.append({
        agent,
        kind: "receipt",
        data: { payTo: requirement.payTo, amount: requirement.amount, network, asset: cardConfig.usdc },
        ...(settleResult.settleResponse.transaction
          ? { txHash: settleResult.settleResponse.transaction as `0x${string}` }
          : {}),
      });
    }

    return secondResponse;
  };
}
