import type { Hono } from "hono";
import type { SupportedChainId, UnderwritingNetwork } from "@advance/core";

export interface HealthRouteOptions {
  chainId: SupportedChainId;
  network: UnderwritingNetwork;
}

/** `GET /health`: liveness probe reporting which chain/network this instance is bound to
 * (never a secret — no RPC URL, no key). */
export function registerHealthRoute(app: Hono, options: HealthRouteOptions): void {
  app.get("/health", (c) =>
    c.json({ status: "ok", chainId: options.chainId, network: options.network }),
  );
}
