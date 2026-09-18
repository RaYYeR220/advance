import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Address } from "viem";
import { ADDRESS_PATTERN } from "../json.js";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import type { AdvanceMcpDeps } from "../server.js";

export function registerScoreTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_score_token",
    {
      title: "Score a token for Advance eligibility",
      description:
        "Free, no-signature eligibility check for revenue-backed credit against a token's Doppler pool fee revenue. Checks the hard rules (WETH-paired pool, not already escrowed, minimum age and recent revenue, no wash-trading/concentration red flags) and, if eligible, the terms a quote would propose (cap, price floor, draw limit). Costs nothing — call this before advance_get_quote (which spends the underwriter's paid memo fee) to see whether a token clears the bar at all. Returns { kind: \"eligible\", terms: {...} } or { kind: \"deny\", reasons: [...] }.",
      inputSchema: {
        token: z
          .string()
          .regex(ADDRESS_PATTERN, "token must be a 0x-prefixed 20-byte address")
          .describe("The agent token's ERC-20 address (must be WETH-paired on a Doppler pool)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling("score_failed", async (args: { token: string }) => {
      const result = await deps.advance.score(args.token as Address);
      return jsonResult(result);
    }),
  );
}
