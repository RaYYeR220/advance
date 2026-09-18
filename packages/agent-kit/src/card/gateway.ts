import { erc20Abi, type Address, type PublicClient } from "viem";
import { agentCardAbi } from "@advance/core";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { SelectPaymentRequirements } from "@x402/core/client";
import type { DynamicKeys } from "../dynamic.js";
import type { EventSink } from "../events.js";
import { cardSigner, type CardSignerKeys } from "./signer.js";
import { precheck, type CardPolicyConfig, type PrecheckResult } from "./policy.js";

export interface CreateCardFetchParams {
  /** Identifies the agent for events, and the {@link DynamicKeys} label whose
   * signatures verify against `AgentCard.owner()` for this card. */
  agent: string;
  /** The AgentCard this fetch spends from. */
  card: Address;
  /** Signs on behalf of the card owner (see {@link cardSigner}). */
  keys: CardSignerKeys;
  /** Refusals, receipts, and settlement failures are appended here. */
  events: EventSink;
  /** A viem `PublicClient` constructed with an explicit `Chain` - both this
   * gateway's on-chain reads (`payees`/`perCallCap`/`maxAuthWindow`/`usdc`/
   * `frozen`/balance) and the x402 CAIP-2 network id (`eip155:<chain.id>`) come
   * from it. Passing an already-configured client (rather than a bare chain id)
   * keeps this gateway free of any built-in RPC default - tests point it at an
   * anvil fork, nothing here ever guesses an endpoint. */
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

/** One candidate this gateway considered while picking a payment requirement to
 * sign, and what `precheck` made of it. */
interface SelectionAttempt {
  requirement: PaymentRequirements;
  decision: PrecheckResult;
}

/** Thrown by the custom payment-requirements selector when none of the
 * candidates x402 offered it satisfy `precheck` - caught by `cardFetch` and
 * turned into a logged refusal, never left to reject `createPaymentPayload`
 * uncaught. */
class NoAcceptablePaymentRequirementError extends Error {
  constructor(readonly attempts: SelectionAttempt[]) {
    super("createCardFetch: no payment requirement option satisfied this card's policy");
  }
}

const GATEWAY_REFUSAL_HEADER = "X-Card-Gateway-Refusal";

function refusalResponse(reason: string): Response {
  return new Response(JSON.stringify({ refused: true, reason }), {
    status: 402,
    headers: { "content-type": "application/json", [GATEWAY_REFUSAL_HEADER]: "1" },
  });
}

/**
 * True for a synthetic refusal `Response` this gateway built itself (a `precheck`
 * failure, or a payment-creation failure caught before any second request was ever
 * sent) - false for any response that actually came back from the wrapped
 * `fetch`, including a genuine upstream 402. Lets a caller tell "the gateway
 * refused this" apart from "the resource server itself said no".
 */
export function isGatewayRefusalResponse(response: Response): boolean {
  return response.headers.get(GATEWAY_REFUSAL_HEADER) === "1";
}

/**
 * Builds the agent's paying `fetch`: wraps a base `fetch` so that a 402 response is
 * answered by paying from `card`, and refuses before ever asking for a signature
 * when every payment option x402 would consider falls outside `card`'s on-chain
 * policy (frozen state, network, asset, payee allowlist, per-call cap,
 * authorization window, available balance - see {@link precheck}). A refusal
 * never reaches the card owner key: it's logged as a `refusal` event and this
 * function synthesizes a `{refused:true, reason}` 402 response itself.
 *
 * A 402 can offer several payment options; x402's own scheme/network filtering
 * and this gateway's policy check must agree on which one gets signed, so
 * `precheck` runs as the client's payment-requirements *selector* itself (via
 * `new x402Client(selector)`) rather than being run once, separately, against
 * `accepts[0]` beforehand - a candidate `precheck` never approved can never be
 * the one x402 goes on to sign.
 *
 * The card contract enforces every one of these rules again on-chain
 * (`AgentCard.isValidSignature`) - this is defense in depth and a fast, logged
 * refusal, not the only line of defense.
 */
export function createCardFetch(params: CreateCardFetchParams): typeof fetch {
  const { agent, card, keys, events, chain, fetchImpl = fetch } = params;

  // An IIFE (rather than a bare `const` + guard) so `chainId`'s type is narrowed
  // to `number` for every closure below - a guard alone doesn't survive capture
  // by the nested functions defined further down.
  const chainId: number = (() => {
    const id = chain.chain?.id;
    if (id === undefined) {
      throw new Error("createCardFetch: chain (the viem PublicClient) must be constructed with an explicit Chain");
    }
    return id;
  })();
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
    // `frozen` and the balance are both mutable (a freeze/unfreeze or a spend can
    // happen between any two requests), so - unlike the params above - both are
    // read fresh every time, never cached.
    const [usdcBalance, frozen] = await Promise.all([
      chain.readContract({
        address: staticParams.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [card],
      }) as Promise<bigint>,
      chain.readContract({ address: card, abi: agentCardAbi, functionName: "frozen" }) as Promise<boolean>,
    ]);
    return { network, ...staticParams, usdcBalance, frozen };
  }

  // Parsing (decoding the PAYMENT-REQUIRED header/body, encoding the payment
  // header, decoding the settlement result) never touches a registered scheme, so
  // it's done through an httpClient wrapping an unregistered client - built once,
  // synchronously, with no on-chain read and no signer.
  const parserHttpClient = new x402HTTPClient(new x402Client());

  /**
   * Builds a fresh signing `x402Client` for one request, registered with a custom
   * payment-requirements selector that runs `precheck` against *this* request's
   * `cardConfig` over exactly the candidates x402 itself would otherwise pick
   * from (already filtered to the scheme/network this gateway registers) -
   * recording every attempt, and returning the first one that passes. If none
   * do, it throws {@link NoAcceptablePaymentRequirementError} instead of ever
   * letting `createPaymentPayload` sign an unapproved candidate. Built fresh per
   * request (not cached) because the selector closes over this request's own
   * `cardConfig` (its USDC balance changes on every spend) and its own
   * `attempts` log.
   */
  function buildSigningClient(cardConfig: CardPolicyConfig, attempts: SelectionAttempt[]): x402Client {
    const selector: SelectPaymentRequirements = (_x402Version, candidates) => {
      for (const candidate of candidates) {
        const decision = precheck(candidate, cardConfig);
        attempts.push({ requirement: candidate, decision });
        if (decision.ok) {
          return candidate;
        }
      }
      throw new NoAcceptablePaymentRequirementError(attempts);
    };

    const client = new x402Client(selector);
    const signer = cardSigner(card, agent, { keys, usdc: cardConfig.usdc as Address, chainId });
    registerExactEvmScheme(client, { signer, networks: [network] });
    return client;
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

    if (paymentRequired.accepts.length === 0) {
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
          options: paymentRequired.accepts.map((a) => ({ payTo: a.payTo, amount: a.amount })),
        },
      });
      return refusalResponse("card_config_unavailable");
    }

    const attempts: SelectionAttempt[] = [];
    const client = buildSigningClient(cardConfig, attempts);

    let paymentPayload;
    try {
      paymentPayload = await client.createPaymentPayload(paymentRequired);
    } catch (err) {
      if (err instanceof NoAcceptablePaymentRequirementError) {
        // Every attempt here failed precheck (the loop only ever throws after
        // trying - and rejecting - every candidate). With exactly one candidate
        // this reduces to the original single-option refusal.
        const only = err.attempts.length === 1 ? err.attempts[0] : undefined;
        const reason = only && !only.decision.ok ? only.decision.reason : "no_acceptable_payment_option";
        await events.append({
          agent,
          kind: "refusal",
          data: {
            layer: "gateway",
            reason,
            ...(only ? { payTo: only.requirement.payTo, amount: only.requirement.amount } : {}),
            options: err.attempts.map((a) => ({
              payTo: a.requirement.payTo,
              amount: a.requirement.amount,
              reason: a.decision.ok ? undefined : a.decision.reason,
            })),
          },
        });
        return refusalResponse(reason);
      }

      // Anything else - the signer's own assertions, x402 finding no
      // scheme/network match at all, or any other failure while building the
      // payload - is caught here too: this never rejects out of `cardFetch`.
      await events.append({
        agent,
        kind: "refusal",
        data: {
          layer: "gateway",
          reason: "payment_creation_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return refusalResponse("payment_creation_failed");
    }

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

    // Whatever was actually selected and signed - never the original 402's
    // `accepts[0]` - is what gets reported from here on.
    const accepted = paymentPayload.accepted;

    if (settleResult.settleResponse?.success) {
      await events.append({
        agent,
        kind: "receipt",
        data: { payTo: accepted.payTo, amount: accepted.amount, network, asset: cardConfig.usdc },
        ...(settleResult.settleResponse.transaction
          ? { txHash: settleResult.settleResponse.transaction as `0x${string}` }
          : {}),
      });
    } else if (!secondResponse.ok || settleResult.settleResponse) {
      // Precheck passed and a signature was sent, but the facilitator or the
      // chain itself rejected settlement (e.g. a stale nonce, a reverted
      // transferWithAuthorization) - distinct from a gateway `refusal`, which
      // never reaches this point.
      await events.append({
        agent,
        kind: "settlement_failed",
        data: {
          payTo: accepted.payTo,
          amount: accepted.amount,
          network,
          asset: cardConfig.usdc,
          status: secondResponse.status,
          errorReason: settleResult.settleResponse?.errorReason,
          errorMessage: settleResult.settleResponse?.errorMessage,
        },
      });
    }

    return secondResponse;
  };
}
