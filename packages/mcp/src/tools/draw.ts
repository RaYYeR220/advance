import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Address } from "viem";
import { explorerTxUrl } from "@advance/sdk";
import { ADDRESS_PATTERN } from "../json.js";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import { requireConfirmedSigner } from "../writeGuard.js";
import type { AdvanceMcpDeps } from "../server.js";

export function registerDrawTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_draw_credit",
    {
      title: "Draw USDC from an active Advance credit line",
      description:
        "Write, requires confirm: true and a configured signer. Draws `amount` USDC-wei from loanId's credit line into `card` — only the card's own owner can call this (AgentCard.drawCredit reverts otherwise), and only up to what advance_loan_status's `available` field reports is left in the current draw period. SAFETY: `card` must be the AgentCard this loan's term sheet actually names as agentCard — drawing into any other card address will simply revert (the credit line checks the caller), but pass the right one anyway. The card enforces its own payee allowlist downstream of this draw; never try to route drawn funds outside that allowlist.",
      inputSchema: {
        card: z
          .string()
          .regex(ADDRESS_PATTERN, "card must be a 0x-prefixed 20-byte address")
          .describe("The AgentCard contract to draw into — must own this loan's credit line."),
        loanId: z.string().regex(/^\d+$/, "loanId must be a non-negative decimal integer string"),
        amount: z
          .string()
          .regex(/^\d+$/, "amount must be a non-negative decimal integer string")
          .describe("USDC-wei (6 decimals) to draw."),
        confirm: z.boolean().default(false).describe("Must be true to actually send a transaction."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(
      "draw_failed",
      async (args: { card: string; loanId: string; amount: string; confirm: boolean }) => {
        const guard = await requireConfirmedSigner(args.confirm, deps.signer);
        if ("blocked" in guard) return guard.blocked;

        const { hash } = await deps.advance.draw(guard.wallet, {
          card: args.card as Address,
          loanId: BigInt(args.loanId),
          amount: BigInt(args.amount),
        });

        return jsonResult({ ok: true, hash, explorerUrl: explorerTxUrl(deps.chainId, hash) });
      },
    ),
  );
}
