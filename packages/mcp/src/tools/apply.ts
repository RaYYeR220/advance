import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explorerTxUrl, type ApproveDecision } from "@advance/sdk";
import { reviveBigints } from "../json.js";
import { errorResult, jsonResult, withErrorHandling } from "../toolResult.js";
import { requireConfirmedSigner } from "../writeGuard.js";
import { ApproveDecisionInputSchema, formatIssues } from "../termSheetSchema.js";
import type { AdvanceMcpDeps } from "../server.js";

/** Only checks the one field cheap enough to branch on before running the full schema: whether
 * this was even an approved decision in the first place, so a plain denied quote gets its own
 * friendly `decision_not_approved` error instead of being reported as a pile of missing-field
 * schema issues. */
function revivedKind(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
}

export function registerApplyTool(server: McpServer, deps: AdvanceMcpDeps): void {
  server.registerTool(
    "advance_apply",
    {
      title: "Open an Advance loan from an approved quote",
      description:
        "Write, requires confirm: true and a configured signer. Turns an approved advance_get_quote decision into a live loan: points the token's Doppler fee beneficiary at the loan's escrow (moveBeneficiary), then calls AdvanceHub.openLoan with the signed term sheet. Pass `decision` as the *exact* JSON object advance_get_quote returned when its `kind` was \"approve\" — don't retype fields, the signature only verifies against byte-identical values. The signer must be the term sheet's agentTreasury (the account that currently holds the Doppler beneficiary shares this moves) and needs ETH for gas on both transactions. SAFETY: never redirect the fee beneficiary anywhere except the escrow address this tool itself predicts from the term sheet — that's the one place this loan's revenue is allowed to flow. Deadline in the term sheet is enforced on-chain; an expired quote reverts, get a fresh one with advance_get_quote.",
      inputSchema: {
        decision: z
          .record(z.string(), z.unknown())
          .describe(
            "The full JSON object returned by advance_get_quote (kind must be \"approve\"), copied verbatim — bigint fields as the same decimal strings that call returned.",
          ),
        confirm: z.boolean().default(false).describe("Must be true to actually send transactions."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(
      "apply_failed",
      async (args: { decision: Record<string, unknown>; confirm: boolean }) => {
        const guard = await requireConfirmedSigner(args.confirm, deps.signer);
        if ("blocked" in guard) return guard.blocked;

        const revived = reviveBigints(args.decision);
        if (revivedKind(revived) !== "approve") {
          return errorResult(
            "decision_not_approved",
            'decision.kind must be "approve" with a termSheet and signature — this quote was denied or malformed.',
          );
        }

        // Full field-by-field validation (addresses checksummed and non-zero, every id/amount
        // within its Solidity type's range, every hash a real 32 bytes) — this is the boundary
        // between an arbitrary caller-supplied JSON object and the chain layer; nothing past this
        // point should be able to reach `predictEscrow`/`prepareApplication`/`openLoan` unvalidated.
        const parsed = ApproveDecisionInputSchema.safeParse(revived);
        if (!parsed.success) {
          return errorResult("invalid_decision", formatIssues(parsed.error));
        }
        const decision = parsed.data as unknown as ApproveDecision;

        const escrow = await deps.advance.predictEscrow(decision.termSheet);
        // `prepareApplication`'s `openLoan` tx is discarded — `deps.advance.openLoan` below sends
        // the exact same call via the SDK's simulate-then-write path, which also recovers the
        // assigned `loanId` from the simulation's return value (the raw encoded tx alone can't).
        const { moveBeneficiary } = deps.advance.prepareApplication(decision);

        const moveBeneficiaryTx = await deps.advance.sendPreparedTx(guard.wallet, moveBeneficiary);
        const { hash: openLoanHash, loanId } = await deps.advance.openLoan(guard.wallet, decision);

        return jsonResult({
          ok: true,
          escrow,
          loanId,
          moveBeneficiaryTxHash: moveBeneficiaryTx.hash,
          moveBeneficiaryExplorerUrl: explorerTxUrl(deps.chainId, moveBeneficiaryTx.hash),
          openLoanTxHash: openLoanHash,
          openLoanExplorerUrl: explorerTxUrl(deps.chainId, openLoanHash),
        });
      },
    ),
  );
}
