import type { WalletClient } from "viem";
import type { SignerResolver } from "./types.js";
import { errorResult, type ToolResult } from "./toolResult.js";

/**
 * Every write tool's first move: refuse without `confirm: true` (an agent must opt in to
 * spending gas/money explicitly, never as a side effect of just calling the tool), then refuse
 * without a configured signer (structured, not a thrown protocol error, so an agent can branch
 * on `error` programmatically instead of parsing prose). Returns the `WalletClient` to sign with
 * once both checks pass.
 */
export async function requireConfirmedSigner(
  confirm: boolean,
  signer: SignerResolver,
): Promise<{ wallet: WalletClient } | { blocked: ToolResult }> {
  if (!confirm) {
    return {
      blocked: errorResult(
        "confirmation_required",
        "This tool moves funds or signs an on-chain transaction. Call it again with confirm: true once you intend to go through with it.",
      ),
    };
  }
  const wallet = await signer();
  if (!wallet) {
    return {
      blocked: errorResult(
        "signer_not_configured",
        "No signer is configured for this server (ADVANCE_SIGNER is unset or not a usable key). Read tools still work; write tools need a signer to be configured before they can send a transaction.",
      ),
    };
  }
  return { wallet };
}
