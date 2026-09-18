import type { DenyReason } from "./scoreTypes";

export interface DenyReasonCopy {
  /** Short, plain-language headline for the exhibit. */
  title: string;
  /** One or two sentences explaining the reason a reader with no protocol background can follow. */
  body: string;
}

/** Plain-language explanations for every reason `score()`/`underwrite()` can deny a token —
 * a `Record` over the full `DenyReason` union, so TypeScript itself catches a reason the
 * engine adds that this copy hasn't been taught yet. */
export const DENY_REASON_COPY: Record<DenyReason, DenyReasonCopy> = {
  not_bankr_doppler: {
    title: "Not a Bankr-launched token",
    body: "Advance only reads fee streams from tokens launched through Bankr's Doppler pools. No matching pool was found there, or on the underlying Airlock registry.",
  },
  not_weth_pool: {
    title: "Not paired with WETH",
    body: "This token's pool trades against something other than WETH, so there's no ETH-denominated fee stream for the engine to project.",
  },
  pool_not_locked: {
    title: "Pool not locked",
    body: "Fee rights can only be escrowed once a pool's liquidity is permanently locked. As of the latest block, this one isn't.",
  },
  creator_has_no_shares: {
    title: "Creator holds no fee shares",
    body: "The wallet that would receive the loan currently has zero share of this pool's trading fees, so there's nothing to lend against.",
  },
  already_escrowed: {
    title: "Already backing a loan",
    body: "Another loan already holds this token's fee rights. A token can only back one loan at a time.",
  },
  too_young: {
    title: "Token too young",
    body: "Advance requires at least three days of trading history before it will underwrite a fee stream — early volume is too easy to fake.",
  },
  no_recent_revenue: {
    title: "No revenue in the last 7 days",
    body: "Zero creator revenue was read for the last week, so there's nothing recent to project forward.",
  },
  wash_trading: {
    title: "Wash trading",
    body: "Too many of the sampled swaps came from the token's own creator wallet — a pattern more consistent with inflated volume than real usage.",
  },
  concentrated_flow: {
    title: "Trading too concentrated",
    body: "Most of the sampled swaps came from a small handful of wallets — too thin a base to trust the fee stream.",
  },
  below_minimum: {
    title: "Loan too small",
    body: "After every haircut, the loan this fee stream supports comes out under the program's minimum principal.",
  },
  memo_denied: {
    title: "Declined by the written memo",
    body: "The formula's terms were eligible, but the underwriting memo — which can only tighten terms, never loosen them — found a reason to decline.",
  },
  memo_unavailable: {
    title: "Memo unavailable",
    body: "Scoring reached the memo step but couldn't get a usable response back, so it declined rather than lend on an unreviewed result.",
  },
  data_unavailable: {
    title: "Data unavailable",
    body: "A chain or pricing read failed partway through scoring. This is usually transient — try again shortly.",
  },
};

/** Letters exhibits, `A, B, C, ...`, wrapping past `Z` only in the unlikely case there are
 * ever more than 26 reasons on one decision. */
export function exhibitLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}
