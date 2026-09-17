import type { MiddlewareHandler } from "hono";

/**
 * Real middleware seam on `POST /v1/quote` for x402 payment enforcement — a no-op today.
 * Swapping this body for an actual 402/payment check (see the x402 proxy in `apps/agents`)
 * is the only change needed to start charging for quotes; every other part of the route
 * (validation, the engine call, evidence storage) is already written against this seam.
 */
export function paymentGate(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}
