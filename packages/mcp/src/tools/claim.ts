import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explorerTxUrl } from "@advance/sdk";
import { jsonResult, withErrorHandling } from "../toolResult.js";
import { requireConfirmedSigner } from "../writeGuard.js";
import type { AdvanceMcpDeps } from "../server.js";

export function registerClaimTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_claim_repayments",
    {
      title: "Claim owed USDC from an Advance revenue note",
      description:
        "Write, requires confirm: true and a configured signer. Claims the signer's owed USDC from loanId's revenue note — for a lender who bid and received notes once the auction settled, this pays out its share of what the escrow has swept in so far. Reverts on-chain if the signer is the auction contract's own holder (nothing to claim until notes are actually distributed to bidders) or if there's simply nothing owed yet. Check advance_loan_status's `repaid`/`cap` fields first to see whether the note has anything to distribute.",
      inputSchema: {
        loanId: z.string().regex(/^\d+$/, "loanId must be a non-negative decimal integer string"),
        confirm: z.boolean().default(false).describe("Must be true to actually send a transaction."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling("claim_failed", async (args: { loanId: string; confirm: boolean }) => {
      const guard = await requireConfirmedSigner(args.confirm, deps.signer);
      if ("blocked" in guard) return guard.blocked;

      const { hash, amount } = await deps.advance.claim(guard.wallet, BigInt(args.loanId));

      return jsonResult({ ok: true, hash, amount, explorerUrl: explorerTxUrl(deps.chainId, hash) });
    }),
  );
}
