export interface AnswerKeyEntry {
  category: string;
  kind: "approve" | "deny";
  /** Expected deny-reason SET (order-independent); empty for an approve. */
  denyReasons: string[];
  /** `[minCap,maxCap]` micro-USD, decimal strings (bigint-safe JSON) — null for a deny. */
  capBandMicroUsd: [string, string] | null;
  /** Pre-memo formula cap/floor/drawLimit — the ceiling every approval (after any
   * legitimate tighten) must never exceed. Null only when a pool-shape check
   * (not_weth_pool / pool_not_locked) denies before the formula ever runs. */
  formulaCapMicroUsd: string | null;
  formulaFloorCents: number | null;
  formulaDrawLimitMicroUsd: string | null;
}

export type AnswerKey = Record<string, AnswerKeyEntry>;
