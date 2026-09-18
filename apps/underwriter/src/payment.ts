import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { chainAddresses } from "@advance/core";
import type { UnderwriterConfig } from "./config.js";

/** Atomic USDC units (6 decimals) charged per quote: 50000 == $0.05. */
export const QUOTE_PRICE_ATOMIC_USDC = "50000";

/** USDC's on-chain EIP-712 domain (name, version), required by the x402 "exact" scheme's
 * `transferWithAuthorization` signature. Confirmed on-chain via `name()`/`version()`: Base
 * mainnet USDC reports "USD Coin"; Base Sepolia's USDC test deployment reports the
 * shorter "USDC". Both report EIP-712 version "2". */
const USDC_EIP712_DOMAIN_BY_CHAIN: Readonly<Record<number, { name: string; version: string }>> = {
  8453: { name: "USD Coin", version: "2" },
  84532: { name: "USDC", version: "2" },
};

function usdcEip712DomainForChain(chainId: number): { name: string; version: string } {
  const domain = USDC_EIP712_DOMAIN_BY_CHAIN[chainId];
  if (!domain) {
    throw new Error(`no USDC EIP-712 domain configured for chain ${chainId}`);
  }
  return domain;
}

/** Builds the CAIP-2 network id x402 expects (e.g. "eip155:84532"). */
export function networkForChain(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`;
}

export interface CreatePaymentGateOptions {
  /** Injected for tests: an in-process facilitator wired to an anvil fork (see
   * `test/helpers/in-process-facilitator.ts`). Defaults to an HTTP client against
   * `config.X402_FACILITATOR_URL`. */
  facilitatorClient?: FacilitatorClient;
  /** Whether the resource server syncs supported kinds from the facilitator on the first
   * request. Defaults to the middleware default (true) — safe even in tests, since an
   * injected in-process facilitator never touches the network. */
  syncFacilitatorOnStart?: boolean;
}

/**
 * Builds the x402 payment gate for `POST /v1/quote`: scheme "exact", network derived from
 * `config.CHAIN_ID`, USDC at the address this repo already trusts for that chain
 * (`@advance/core`'s `chainAddresses`), amount `QUOTE_PRICE_ATOMIC_USDC` (0.05 USDC),
 * `payTo = config.UNDERWRITER_PAYTO`.
 *
 * The returned middleware only enforces payment on `POST /v1/quote` — x402's own route
 * matching is a documented no-op (`{ type: "no-payment-required" }`) for any path/method
 * it wasn't configured for, so mounting this at the app level never touches `/health`,
 * `GET /v1/score/:token`, or `GET /v1/evidence/:hash`.
 *
 * If `config.UNDERWRITER_INTERNAL_KEY` is set, a request carrying the exact same value in
 * `X-Internal-Key` skips this gate entirely instead of being charged again — this is how
 * the Bankr x402 Cloud handler (`apps/underwriter-x402`) forwards a request here after its
 * own edge has already collected payment, without this API charging it a second time.
 * Comparison is constant-time and the key is never logged. With no key configured (the
 * default), the header is never even read: every request goes through the real x402 gate,
 * so this bypass cannot be enabled by accident.
 */
export function createPaymentGate(config: UnderwriterConfig, options: CreatePaymentGateOptions = {}): MiddlewareHandler {
  const facilitatorClient = options.facilitatorClient ?? new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL });
  const network = networkForChain(config.CHAIN_ID);
  const asset = chainAddresses(config.CHAIN_ID).usdc;
  const extra = usdcEip712DomainForChain(config.CHAIN_ID);

  const resourceServer = new x402ResourceServer(facilitatorClient).register(network, new ExactEvmScheme());

  const x402Gate = paymentMiddleware(
    {
      "POST /v1/quote": {
        accepts: {
          scheme: "exact",
          price: { amount: QUOTE_PRICE_ATOMIC_USDC, asset },
          network,
          payTo: config.UNDERWRITER_PAYTO,
          extra,
        },
        description: "Advance underwriting credit memo: full engine run, signed term sheet on approval",
      },
    },
    resourceServer,
    undefined,
    undefined,
    options.syncFacilitatorOnStart,
  );

  const internalKey = config.UNDERWRITER_INTERNAL_KEY;
  if (!internalKey) return x402Gate;
  const expected = Buffer.from(internalKey, "utf8");

  return async (c, next) => {
    const provided = c.req.header("x-internal-key");
    if (provided && isSameKey(provided, expected)) {
      return next();
    }
    // Return (not just await) x402Gate's result: it short-circuits with a 402 `Response`
    // for its own return value, which this wrapper must hand straight back to Hono rather
    // than swallow — an `await`-then-fall-through here would silently discard that 402 and
    // let the real route handler run unpaid.
    return x402Gate(c, next);
  };
}

/** Constant-time comparison against the configured internal key — a naive `===` here would
 * leak how many leading bytes matched through response timing, letting an attacker guess
 * the key byte by byte. Length is checked first (safe to leak; it isn't secret). */
function isSameKey(provided: string, expected: Buffer): boolean {
  const providedBuf = Buffer.from(provided, "utf8");
  return providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected);
}
