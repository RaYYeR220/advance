import type { Hono } from "hono";
import type { Hex } from "viem";
import type { EvidenceStore } from "../store.js";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface EvidenceRouteOptions {
  evidenceStore: EvidenceStore;
}

/** `GET /v1/evidence/:hash`: the canonical JSON bundle behind any decision `score`/`quote`
 * returned — re-hashing the returned body (via `@advance/core`'s `evidenceHash`) always
 * reproduces `:hash` exactly, since it's stored bigint-safe with the same string
 * conversion `evidenceHash` itself applies. */
export function registerEvidenceRoute(app: Hono, options: EvidenceRouteOptions): void {
  app.get("/v1/evidence/:hash", (c) => {
    const hash = c.req.param("hash");
    if (!HASH_PATTERN.test(hash)) {
      return c.json({ error: "invalid evidence hash" }, 400);
    }
    const bundle = options.evidenceStore.get(hash as Hex);
    if (bundle === undefined) {
      return c.json({ error: "evidence not found" }, 404);
    }
    return c.json(bundle as Record<string, unknown>, 200);
  });
}
