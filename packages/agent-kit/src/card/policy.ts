/**
 * Minimal shape of an x402 v2 `PaymentRequirements` entry this gateway cares about
 * (`@x402/core`'s `PaymentRequirements` is structurally compatible - passing one
 * straight through works without a cast).
 */
export interface PaymentRequirementLike {
  /** CAIP-2 network id, e.g. "eip155:8453". */
  network: string;
  /** Asset (token) contract address the payment is denominated in. */
  asset: string;
  /** Payee address. */
  payTo: string;
  /** Atomic-unit amount, as a decimal string (x402's wire format). */
  amount: string;
  /** Seconds the resource server allows for the authorization window. */
  maxTimeoutSeconds: number;
}

/** The card facts `precheck` needs, snapshotted by the caller (the gateway reads
 * these on-chain: `payees`/`perCallCap`/`maxAuthWindow`/`usdc` are immutable once
 * the card is deployed and safe to cache indefinitely; `usdcBalance` changes with
 * every spend and must be read fresh). */
export interface CardPolicyConfig {
  /** CAIP-2 network id this card's gateway is configured to pay on. */
  network: string;
  /** The card's own `usdc()` - the only asset it can ever pay with. */
  usdc: string;
  /** The card's fixed payee allowlist (`payees()`). */
  payees: readonly string[];
  /** The card's `perCallCap()`, USDC-wei. */
  perCallCap: bigint;
  /** The card's `maxAuthWindow()`, seconds. */
  maxAuthWindow: bigint;
  /** The card's current USDC balance, USDC-wei. */
  usdcBalance: bigint;
  /** The card's current `frozen()` state. Mutable (the hub can freeze/unfreeze at
   * any time), so - unlike `payees`/`perCallCap`/`maxAuthWindow`/`usdc` - it must
   * be read fresh, never cached. */
  frozen: boolean;
}

export type PrecheckRefusalReason =
  | "card_frozen"
  | "network_mismatch"
  | "asset_mismatch"
  | "invalid_amount"
  | "payee_not_allowlisted"
  | "amount_exceeds_per_call_cap"
  | "timeout_exceeds_auth_window"
  | "amount_exceeds_card_balance";

export type PrecheckResult = { ok: true } | { ok: false; reason: PrecheckRefusalReason };

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Pure policy check run before the gateway ever asks the card owner for a signature.
 * Mirrors (and never loosens) what `AgentCard.isValidSignature` itself enforces
 * on-chain: this is the fast, logged refusal layer in front of it, not a
 * replacement for it. No I/O, no mutation of its inputs.
 */
export function precheck(req: PaymentRequirementLike, card: CardPolicyConfig): PrecheckResult {
  if (card.frozen) {
    return { ok: false, reason: "card_frozen" };
  }
  if (req.network !== card.network) {
    return { ok: false, reason: "network_mismatch" };
  }
  if (!sameAddress(req.asset, card.usdc)) {
    return { ok: false, reason: "asset_mismatch" };
  }

  let amount: bigint;
  try {
    amount = BigInt(req.amount);
  } catch {
    return { ok: false, reason: "invalid_amount" };
  }
  if (amount < 0n) {
    return { ok: false, reason: "invalid_amount" };
  }

  if (!card.payees.some((payee) => sameAddress(payee, req.payTo))) {
    return { ok: false, reason: "payee_not_allowlisted" };
  }
  if (amount > card.perCallCap) {
    return { ok: false, reason: "amount_exceeds_per_call_cap" };
  }
  if (BigInt(req.maxTimeoutSeconds) > card.maxAuthWindow) {
    return { ok: false, reason: "timeout_exceeds_auth_window" };
  }
  if (amount > card.usdcBalance) {
    return { ok: false, reason: "amount_exceeds_card_balance" };
  }

  return { ok: true };
}
