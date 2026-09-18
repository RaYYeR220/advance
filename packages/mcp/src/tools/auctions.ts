import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Address } from "viem";
import { q96ToCents } from "@advance/sdk";
import { ADDRESS_PATTERN } from "../json.js";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import type { AdvanceMcpDeps } from "../server.js";

function clearingPriceCents(priceQ96: bigint): number | undefined {
  try {
    return q96ToCents(priceQ96);
  } catch {
    // Only ever off-tick mid-checkpoint on a live auction; omit rather than report a wrong price.
    return undefined;
  }
}

export function registerAuctionsTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_list_auctions",
    {
      title: "List live Advance note auctions",
      description:
        "Free read. Every loan currently in its CCA note auction (before it's graduated to an active credit line), with each auction's clearing price, currency raised so far, blocks left and graduation status. Use this to find an auction to bid on with advance_bid_on_note, or to check whether one you already bid on has graduated. Optionally filter by borrower (agentTreasury).",
      inputSchema: {
        agent: z
          .string()
          .regex(ADDRESS_PATTERN, "agent must be a 0x-prefixed 20-byte address")
          .optional()
          .describe("Filter to loans borrowed by this agentTreasury address."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling("list_auctions_failed", async (args: { agent?: string }) => {
      const loans = await deps.advance.loans({
        status: "Auction",
        agent: args.agent as Address | undefined,
      });
      const auctions = await Promise.all(
        loans.map(async (loan) => {
          const auction = await deps.advance.auction(loan.loanId);
          return {
            loanId: loan.loanId,
            agentTreasury: loan.termSheet.agentTreasury,
            floorCents: loan.termSheet.floorCents,
            noteSupply: loan.termSheet.noteSupply,
            auction: loan.auction,
            currency: auction.currency,
            endBlock: auction.endBlock,
            blocksLeft: auction.blocksLeft,
            graduated: auction.graduated,
            clearingPriceQ96: auction.clearingPriceQ96,
            clearingPriceCents: clearingPriceCents(auction.clearingPriceQ96),
            requiredCurrencyRaised: auction.requiredCurrencyRaised,
            raisedSoFar: auction.raisedSoFar,
          };
        }),
      );
      return jsonResult({ auctions });
    }),
  );
}
