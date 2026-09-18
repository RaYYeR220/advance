import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explorerTxUrl } from "@advance/sdk";
import type { Hex } from "viem";
import { ADDRESS_PATTERN } from "../json.js";
import { jsonResult, errorResult, withErrorHandling } from "../toolResult.js";
import { RefusalSourceUnavailable, type RefusalEvent } from "../refusalSource.js";
import type { AdvanceMcpDeps } from "../server.js";

function explain(event: RefusalEvent): string {
  const { layer, reason, payTo, amount } = event.data;
  if (event.kind === "settlement_failed") {
    return `approved at ${layer} but the on-chain call itself failed: ${reason}`;
  }
  const target = payTo ? ` paying ${payTo}${amount ? ` (${amount})` : ""}` : "";
  return `refused at ${layer}:${target} — ${reason}`;
}

export function registerRefusalTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_explain_refusal",
    {
      title: "Explain an agent's recent credit-policy refusals",
      description:
        "Free read. The latest refusal / settlement-failure events the runtime recorded for `agent` — why an on-chain action it tried was refused before it ever reached the chain (e.g. a payment outside the card's allowlist, a beneficiary move to somewhere other than the predicted escrow), or why an approved action's transaction itself failed. Use this after a write tool here returns an error, or when an agent's own credit-guarded actions keep failing, to see the policy reason in plain terms rather than just a revert string. Depends on ADVANCE_EVENTS_URL being configured on this server; returns a structured 'events_unavailable' error if it isn't (never a fabricated empty history).",
      inputSchema: {
        agent: z
          .string()
          .regex(ADDRESS_PATTERN, "agent must be a 0x-prefixed 20-byte address")
          .describe("The agent address the runtime logs refusal events under."),
        limit: z.number().int().positive().max(50).default(5).describe("Max events to return, newest first."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling("explain_refusal_failed", async (args: { agent: string; limit: number }) => {
      let events: RefusalEvent[];
      try {
        events = await deps.refusalSource.latestForAgent(args.agent, args.limit);
      } catch (err) {
        if (err instanceof RefusalSourceUnavailable) {
          return errorResult("events_unavailable", err.message);
        }
        throw err;
      }

      return jsonResult({
        agent: args.agent,
        events: events.map((event) => ({
          ...event,
          explanation: explain(event),
          explorerUrl: event.txHash ? explorerTxUrl(deps.chainId, event.txHash as Hex) : undefined,
        })),
      });
    }),
  );
}
