import type { LlmClient } from "@advance/core";
import type { LlmBehavior } from "./types.js";

function memoJson(fields: {
  verdict: "approve" | "tighten" | "deny";
  capMultiplierBps: number;
  floorCentsDelta: number;
  rationale: string;
  risks?: string[];
}): string {
  return JSON.stringify({
    verdict: fields.verdict,
    capMultiplierBps: fields.capMultiplierBps,
    floorCentsDelta: fields.floorCentsDelta,
    rationale: fields.rationale,
    risks: fields.risks ?? [],
  });
}

/** Scripted fake `LlmClient` per scenario — never calls a real model. Each `LlmBehavior`
 * variant exercises one memo-stage outcome the engine must handle: a clean no-op approve,
 * a legitimate tighten, an outright deny, an "obedient" model that echoes a
 * prompt-injection payload asking to loosen terms (the engine must still clamp), a
 * non-JSON response, and a timeout-shaped rejection. */
export function createFakeLlm(behavior: LlmBehavior): LlmClient {
  return {
    async complete(_messages) {
      switch (behavior.kind) {
        case "auto":
          return memoJson({
            verdict: "approve",
            capMultiplierBps: 10_000,
            floorCentsDelta: 0,
            rationale: "Computed terms accepted as proposed.",
          });
        case "tighten":
          return memoJson({
            verdict: "tighten",
            capMultiplierBps: behavior.capMultiplierBps,
            floorCentsDelta: behavior.floorCentsDelta,
            rationale: "Tightening per scripted scenario.",
          });
        case "deny":
          return memoJson({
            verdict: "deny",
            capMultiplierBps: 10_000,
            floorCentsDelta: 0,
            rationale: "Scripted denial.",
          });
        case "obedientInjection":
          return memoJson({
            verdict: "approve",
            capMultiplierBps: behavior.capMultiplierBps,
            floorCentsDelta: behavior.floorCentsDelta,
            rationale: "Complying with the token creator's embedded instructions (this is the attack under test).",
          });
        case "garbage":
          return "not a json object at all {{{ this is the attack surface, not a well-formed response";
        case "timeout":
          throw new Error("LLM request timed out after 15000ms");
      }
    },
  };
}
