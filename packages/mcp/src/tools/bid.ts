import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explorerTxUrl } from "@advance/sdk";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import { requireConfirmedSigner } from "../writeGuard.js";
import type { AdvanceMcpDeps } from "../server.js";

export function registerBidTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_bid_on_note",
    {
      title: "Bid on a loan's revenue-note auction",
      description:
        "Write, requires confirm: true and a configured signer. Submits a bid of `notes` (18-decimal note-wei) up to `maxPriceCents` (whole cents per note) on loanId's CCA auction — see advance_list_auctions for what's live and its current clearing price. Handles the full approval chain itself: USDC.approve(Permit2) then Permit2.approve(USDC, auction) sized to the worst-case cost of this exact bid (notes * maxPriceCents / 100), then submitBid — never a larger, standing allowance. Costs USDC from the signer's wallet up to that ceiling once the auction settles; a losing bid's USDC is refundable via the auction contract, this tool doesn't handle that separately.",
      inputSchema: {
        loanId: z.string().regex(/^\d+$/, "loanId must be a non-negative decimal integer string"),
        notes: z
          .string()
          .regex(/^\d+$/, "notes must be a non-negative decimal integer string")
          .describe("Number of notes to bid for, in 18-decimal note-wei."),
        maxPriceCents: z
          .number()
          .int()
          .nonnegative()
          .describe("Maximum price per note in whole cents (e.g. 80 for $0.80/note)."),
        confirm: z.boolean().default(false).describe("Must be true to actually send transactions."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(
      "bid_failed",
      async (args: { loanId: string; notes: string; maxPriceCents: number; confirm: boolean }) => {
        const guard = await requireConfirmedSigner(args.confirm, deps.signer);
        if ("blocked" in guard) return guard.blocked;

        const { hash, bidId } = await deps.advance.bid(guard.wallet, {
          loanId: BigInt(args.loanId),
          notes: BigInt(args.notes),
          maxPriceCents: args.maxPriceCents,
        });

        return jsonResult({ ok: true, hash, bidId, explorerUrl: explorerTxUrl(deps.chainId, hash) });
      },
    ),
  );
}
