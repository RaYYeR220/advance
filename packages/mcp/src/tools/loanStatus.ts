import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explorerAddressUrl } from "@advance/sdk";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import type { AdvanceMcpDeps } from "../server.js";

export function registerLoanStatusTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_loan_status",
    {
      title: "Read an Advance loan's on-chain status",
      description:
        "Free read. Full on-chain state for one loan, straight off AdvanceHub and its note/credit-line/escrow contracts (no indexer, always current as of the latest block): lifecycle status (Auction, Active, Repaid, Defaulted, Failed, Aborted), the note's repayment cap and cumulative repaid, the credit line's principal/drawn/available-this-period, and the escrow's last revenue timestamp. Use this to check whether a loan is ready to draw against, how much room is left this draw period, or whether it has defaulted.",
      inputSchema: {
        loanId: z
          .string()
          .regex(/^\d+$/, "loanId must be a non-negative decimal integer string")
          .describe("The loan id, as returned by advance_apply's openLoan or seen in advance_list_auctions."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling("loan_status_failed", async (args: { loanId: string }) => {
      const loan = await deps.advance.loan(BigInt(args.loanId));
      return jsonResult({
        ...loan,
        links: {
          escrow: explorerAddressUrl(deps.chainId, loan.escrow),
          note: explorerAddressUrl(deps.chainId, loan.note),
          creditLine: explorerAddressUrl(deps.chainId, loan.creditLine),
          auction: explorerAddressUrl(deps.chainId, loan.auction),
        },
      });
    }),
  );
}
