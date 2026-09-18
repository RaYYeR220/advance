import type { EvidenceBundle, ScoreResult } from "@advance/sdk";

/**
 * Types the underwriting engine (`@advance/core`) defines but `@advance/sdk` doesn't re-export
 * on its own — derived structurally off `ScoreResult`/`EvidenceBundle` (which the SDK does
 * export) instead of adding a second workspace dependency just for their names.
 */
export type DenyReason = Extract<ScoreResult, { kind: "deny" }>["reasons"][number];
export type Quality = EvidenceBundle["formula"]["quality"];
export type RevenueWindows = EvidenceBundle["formula"]["revenue"];
export type ComputedTerms = EvidenceBundle["formula"]["computedTerms"];
