import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupportedChainId } from "@advance/core";
import type { AdvanceOperations, SignerResolver } from "./types.js";
import type { RefusalSource } from "./refusalSource.js";
import { registerScoreTool } from "./tools/score.js";
import { registerQuoteTool } from "./tools/quote.js";
import { registerApplyTool } from "./tools/apply.js";
import { registerLoanStatusTool } from "./tools/loanStatus.js";
import { registerAuctionsTool } from "./tools/auctions.js";
import { registerBidTool } from "./tools/bid.js";
import { registerDrawTool } from "./tools/draw.js";
import { registerClaimTool } from "./tools/claim.js";
import { registerRefusalTool } from "./tools/refusal.js";

export const SERVER_NAME = "advance";
export const SERVER_VERSION = "0.1.0";

/** Everything the tool set needs, injected so tests (and alternate runtimes) never have to touch
 * a real network, chain, or event feed to exercise this server. */
export interface AdvanceMcpDeps {
  advance: AdvanceOperations;
  chainId: SupportedChainId;
  /** Resolves the wallet write tools sign with; `undefined` when none is configured. */
  signer: SignerResolver;
  refusalSource: RefusalSource;
}

/**
 * Builds a fresh `McpServer` with every Advance tool registered against `deps`. Called once for
 * a long-lived stdio connection, and once per request for the stateless Streamable HTTP
 * transport (see `http.ts`) — cheap and side-effect free, so re-creating it per call is fine.
 */
export function buildAdvanceServer(deps: AdvanceMcpDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerScoreTool(server, deps);
  registerQuoteTool(server, deps);
  registerApplyTool(server, deps);
  registerLoanStatusTool(server, deps);
  registerAuctionsTool(server, deps);
  registerBidTool(server, deps);
  registerDrawTool(server, deps);
  registerClaimTool(server, deps);
  registerRefusalTool(server, deps);

  return server;
}
