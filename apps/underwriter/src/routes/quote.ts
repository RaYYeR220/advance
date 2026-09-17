import type { Hono } from "hono";
import type { Address } from "viem";
import { z } from "zod";
import {
  InvalidUnderwriteInput,
  underwrite,
  type SupportedChainId,
  type UnderwriteDeps,
} from "@advance/core";
import { paymentGate } from "../paymentGate.js";
import { toJsonSafe } from "../jsonSafe.js";
import type { EvidenceStore } from "../store.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const quoteBodySchema = z.object({
  token: z.string().regex(ADDRESS_PATTERN, "token must be a 0x-prefixed 20-byte address"),
  agentCard: z.string().regex(ADDRESS_PATTERN, "agentCard must be a 0x-prefixed 20-byte address"),
  agentId: z.coerce.bigint().nonnegative(),
  chainId: z.coerce.number().int(),
});

export interface QuoteRouteOptions {
  deps: UnderwriteDeps;
  hub: Address;
  evidenceStore: EvidenceStore;
  /** Unix seconds; must be within 300s of the chain's own latest block time. Defaults to
   * the real wall clock; tests inject a fixed value matching their fixture's block time. */
  now?: () => number;
}

/**
 * `POST /v1/quote`: the paid path — full engine run (memo request + a signed `TermSheet`
 * on approval). `paymentGate` is a real middleware seam, a no-op until x402 lands.
 */
export function registerQuoteRoute(app: Hono, options: QuoteRouteOptions): void {
  const nowSeconds = options.now ?? (() => Math.floor(Date.now() / 1000));

  app.post("/v1/quote", paymentGate(), async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }

    const parsed = quoteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request body", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        400,
      );
    }
    const { token, agentCard, agentId, chainId } = parsed.data;

    try {
      const decision = await underwrite(
        {
          token: token as Address,
          agentCard: agentCard as Address,
          agentId,
          // `underwrite`'s own input validation rejects any chainId that isn't supported,
          // and (separately) any chainId/env.network combination that doesn't match how
          // this service is configured — so an unsupported or mismatched chainId here
          // surfaces as `InvalidUnderwriteInput` -> 422, not a silent wrong-chain read.
          chainId: chainId as SupportedChainId,
          hub: options.hub,
          now: nowSeconds(),
        },
        options.deps,
      );

      options.evidenceStore.save(decision.evidenceHash, decision.evidence);
      return c.json(toJsonSafe(decision) as Record<string, unknown>, 200);
    } catch (err) {
      if (err instanceof InvalidUnderwriteInput) {
        return c.json({ error: err.message }, 422);
      }
      throw err;
    }
  });
}
