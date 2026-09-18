import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Address } from "viem";
import { ADDRESS_PATTERN } from "../json.js";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import type { AdvanceMcpDeps } from "../server.js";

export function registerQuoteTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_get_quote",
    {
      title: "Get a signed Advance credit quote",
      description:
        "Paid: runs the full underwriting engine (revenue windows, trade-quality checks, an LLM credit memo) and returns a decision. On approval this is a signed EIP-712 TermSheet (cap, price floor, draw limit, auction length) ready to hand to advance_apply verbatim — copy the whole JSON object this tool returns into that tool's `decision` field, don't retype it. On denial it returns the specific reasons. The underwriter charges its configured memo fee for this call (x402, ~0.05 USDC on Base) once payment is enforced on its /v1/quote endpoint; advance_score_token is the free pre-check, use it first. agentId is the caller's ERC-8004 identity (0 if none — reputation is simply skipped, not penalized).",
      inputSchema: {
        token: z
          .string()
          .regex(ADDRESS_PATTERN, "token must be a 0x-prefixed 20-byte address")
          .describe("The agent token's ERC-20 address."),
        agentCard: z
          .string()
          .regex(ADDRESS_PATTERN, "agentCard must be a 0x-prefixed 20-byte address")
          .describe("The AgentCard contract that will own draws against this loan's credit line."),
        agentId: z
          .string()
          .regex(/^\d+$/, "agentId must be a non-negative decimal integer string")
          .describe("The caller's ERC-8004 agent id as a decimal string; \"0\" if none."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling("quote_failed", async (args: { token: string; agentCard: string; agentId: string }) => {
      const decision = await deps.advance.quote({
        token: args.token as Address,
        agentCard: args.agentCard as Address,
        agentId: BigInt(args.agentId),
      });
      return jsonResult(decision);
    }),
  );
}
