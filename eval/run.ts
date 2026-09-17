/**
 * Graded eval runner. Builds in-memory fake engine deps per scenario (`src/fakes.ts`,
 * `src/llmFakes.ts`), runs the real `@advance/core` `underwrite()` against them, and
 * grades the result against the hidden-from-the-engine `answer-key.json` (the only file
 * this module reads to know what's "correct" — it never imports `src/independentFormula.ts`
 * or `src/deriveKey.ts`, which built that key independently of the engine).
 *
 * Usage: `pnpm --filter @advance/eval start` (builds then runs). Prints the scorecard and
 * writes `eval/report.md`. Exits non-zero if any hard invariant is violated, the negative
 * control fails, or any graded metric (decision accuracy, deny-reason precision/recall,
 * approvals within band) is under 100%.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidUnderwriteInput, underwrite, type Decision, type UnderwriteDeps, type UnderwriteInput } from "@advance/core";
import { addressFromSeed } from "./src/addr.js";
import type { AnswerKey, AnswerKeyEntry } from "./src/answerKeyTypes.js";
import { LATEST_TIMESTAMP } from "./src/blockModel.js";
import {
  createFakeBankrClient,
  createFakeChainOps,
  createUnreachableBankrClient,
  resolveAddresses,
} from "./src/fakes.js";
import { buildScenarios } from "./src/gen.js";
import { createFakeLlm } from "./src/llmFakes.js";
import type { ScenarioParams } from "./src/types.js";

// This module is compiled to eval/dist/run.js — one level below eval/.
const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = resolve(HERE, "..");

// Well-known, publicly documented Hardhat/Anvil default test account #0 private key —
// never a real signer, fine to hardcode; the eval never touches a live chain.
const TEST_SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const AGENT_CARD = addressFromSeed("eval-agent-card");
const HUB = addressFromSeed("eval-hub");

interface ScenarioResult {
  scenario: ScenarioParams;
  entry: AnswerKeyEntry;
  decision: Decision | { kind: "error"; message: string };
  kindMatch: boolean;
  actualReasons: string[];
  expectedReasons: string[];
  actualCapMicroUsd: bigint | null;
  withinBand: boolean | null; // null when not applicable (not an expected+actual approve pair)
  capExceedsFormula: boolean;
  drawLimitAbovePreMemo: boolean;
  floorBelowFormula: boolean;
  injectionLoosened: boolean | null; // null when not a prompt_injection scenario
}

async function runScenario(scenario: ScenarioParams, entry: AnswerKeyEntry): Promise<ScenarioResult> {
  const addresses = resolveAddresses(scenario);
  const chain = createFakeChainOps(scenario, addresses);
  const bankr =
    scenario.discoveryMode === "airlockOnly" ? createUnreachableBankrClient() : createFakeBankrClient(scenario, addresses);
  const llm = createFakeLlm(scenario.llm);

  const deps: UnderwriteDeps = {
    bankr,
    chain,
    llm,
    signerKey: TEST_SIGNER_KEY,
    env: { network: scenario.network },
  };
  const input: UnderwriteInput = {
    token: addresses.token,
    agentCard: AGENT_CARD,
    agentId: 1n,
    chainId: scenario.chainId,
    hub: HUB,
    now: Number(LATEST_TIMESTAMP),
  };

  let decision: Decision | { kind: "error"; message: string };
  try {
    decision = await underwrite(input, deps);
  } catch (err) {
    const message =
      err instanceof InvalidUnderwriteInput
        ? `InvalidUnderwriteInput: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    decision = { kind: "error", message };
  }

  const actualReasons = decision.kind === "deny" ? [...decision.reasons].sort() : [];
  const expectedReasons = [...entry.denyReasons].sort();
  const kindMatch = decision.kind === entry.kind;

  const actualCapMicroUsd = decision.kind === "approve" ? decision.terms.capMicroUsd : null;

  const formulaCap = entry.formulaCapMicroUsd !== null ? BigInt(entry.formulaCapMicroUsd) : null;
  const formulaDrawLimit = entry.formulaDrawLimitMicroUsd !== null ? BigInt(entry.formulaDrawLimitMicroUsd) : null;
  const formulaFloor = entry.formulaFloorCents;

  const capExceedsFormula =
    decision.kind === "approve" && formulaCap !== null && decision.terms.capMicroUsd > formulaCap;
  const drawLimitAbovePreMemo =
    decision.kind === "approve" && formulaDrawLimit !== null && decision.terms.drawLimit > formulaDrawLimit;
  const floorBelowFormula =
    decision.kind === "approve" && formulaFloor !== null && decision.terms.floorCents < formulaFloor;

  const injectionLoosened =
    scenario.category === "prompt_injection"
      ? decision.kind !== "approve" || capExceedsFormula || floorBelowFormula || drawLimitAbovePreMemo
      : null;

  let withinBand: boolean | null = null;
  if (entry.kind === "approve" && decision.kind === "approve") {
    const [minStr, maxStr] = entry.capBandMicroUsd!;
    const min = BigInt(minStr);
    const max = BigInt(maxStr);
    withinBand = decision.terms.capMicroUsd >= min && decision.terms.capMicroUsd <= max;
  }

  return {
    scenario,
    entry,
    decision,
    kindMatch,
    actualReasons,
    expectedReasons,
    actualCapMicroUsd,
    withinBand,
    capExceedsFormula,
    drawLimitAbovePreMemo,
    floorBelowFormula,
    injectionLoosened,
  };
}

function setDiffCounts(actual: string[], expected: string[]): { tp: number; fp: number; fn: number } {
  const a = new Set(actual);
  const e = new Set(expected);
  let tp = 0;
  for (const r of a) if (e.has(r)) tp++;
  const fp = a.size - tp;
  const fn = e.size - tp;
  return { tp, fp, fn };
}

function fmtMicroUsd(v: bigint | null): string {
  if (v === null) return "-";
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `$${sign}${whole}.${frac}`;
}

async function main(): Promise<void> {
  const answerKey = JSON.parse(readFileSync(resolve(EVAL_ROOT, "answer-key.json"), "utf8")) as AnswerKey;
  const scenarios = buildScenarios();

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const entry = answerKey[scenario.id];
    if (!entry) throw new Error(`answer-key.json is missing scenario "${scenario.id}" — run "derive-key" first`);
    results.push(await runScenario(scenario, entry));
  }

  const total = results.length;
  const kindMatches = results.filter((r) => r.kindMatch).length;
  const decisionAccuracy = kindMatches / total;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of results) {
    const d = setDiffCounts(r.actualReasons, r.expectedReasons);
    tp += d.tp;
    fp += d.fp;
    fn += d.fn;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;

  const expectedApprovals = results.filter((r) => r.entry.kind === "approve");
  const bandChecked = results.filter((r) => r.withinBand !== null);
  const withinBandCount = bandChecked.filter((r) => r.withinBand).length;

  const capExceedsFormulaCount = results.filter((r) => r.capExceedsFormula).length;
  const injectionScenarios = results.filter((r) => r.injectionLoosened !== null);
  const injectionLoosenedCount = injectionScenarios.filter((r) => r.injectionLoosened).length;
  const drawLimitAbovePreMemoCount = results.filter((r) => r.drawLimitAbovePreMemo).length;
  const floorBelowFormulaCount = results.filter((r) => r.floorBelowFormula).length;

  const negativeControl = results.find((r) => r.scenario.id === "negative-control")!;
  const negativeControlPass =
    negativeControl.kindMatch &&
    negativeControl.decision.kind === "deny" &&
    negativeControl.decision.reasons.includes("creator_has_no_shares");

  const hardInvariantsTotal =
    capExceedsFormulaCount + injectionLoosenedCount + drawLimitAbovePreMemoCount + floorBelowFormulaCount;

  // Strict grading: every graded metric must be perfect, not just decision kind. A wrong
  // deny-reason set or an approval landing outside its hand-derived band is a real grading
  // failure (the key says the engine got something wrong), even though neither one is a
  // HARD INVARIANT in the narrower sense above.
  const accuracyOk = decisionAccuracy === 1;
  const precisionOk = precision === 1;
  const recallOk = recall === 1;
  const bandOk = bandChecked.length === expectedApprovals.length && withinBandCount === bandChecked.length;
  const ok = accuracyOk && precisionOk && recallOk && bandOk && hardInvariantsTotal === 0 && negativeControlPass;

  const lines: string[] = [];
  lines.push("# Advance underwriting eval report");
  lines.push("");
  lines.push(`Scenarios: ${total}`);
  lines.push(`Decision accuracy: ${kindMatches}/${total} (${(decisionAccuracy * 100).toFixed(1)}%)`);
  lines.push(`Deny-reason precision: ${(precision * 100).toFixed(1)}% (tp=${tp} fp=${fp})`);
  lines.push(`Deny-reason recall: ${(recall * 100).toFixed(1)}% (tp=${tp} fn=${fn})`);
  lines.push(
    `Approvals within band: ${withinBandCount}/${bandChecked.length} (of ${expectedApprovals.length} expected approvals)`,
  );
  lines.push("");
  lines.push("## Hard invariants (must all be 0)");
  lines.push(`- approvals whose cap exceeds the formula cap: ${capExceedsFormulaCount}`);
  lines.push(`- injection scenarios with loosened terms (cap up / floor down / drawLimit up): ${injectionLoosenedCount}`);
  lines.push(`- approvals with drawLimit above the pre-memo drawLimit: ${drawLimitAbovePreMemoCount}`);
  lines.push(`- approvals with floorCents below the pre-memo floor: ${floorBelowFormulaCount}`);
  lines.push("");
  lines.push("## Negative control");
  lines.push(
    `negative-control: ${negativeControlPass ? "PASS" : "FAIL"} (kind=${negativeControl.decision.kind}, reasons=[${
      negativeControl.decision.kind === "deny" ? negativeControl.decision.reasons.join(", ") : ""
    }])`,
  );
  lines.push("");
  lines.push("## Per-scenario results");
  lines.push("");
  lines.push(
    "| id | category | expected | actual | expected reasons | actual reasons | band | actual cap | in band |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const band = r.entry.capBandMicroUsd
      ? `${fmtMicroUsd(BigInt(r.entry.capBandMicroUsd[0]))}-${fmtMicroUsd(BigInt(r.entry.capBandMicroUsd[1]))}`
      : "-";
    const mark = r.kindMatch ? "" : " **MISMATCH**";
    lines.push(
      `| ${r.scenario.id} | ${r.scenario.category} | ${r.entry.kind} | ${r.decision.kind}${mark} | ${r.expectedReasons.join(
        ", ",
      )} | ${r.actualReasons.join(", ")} | ${band} | ${fmtMicroUsd(r.actualCapMicroUsd)} | ${
        r.withinBand === null ? "-" : r.withinBand ? "yes" : "**NO**"
      } |`,
    );
  }
  lines.push("");
  lines.push(`Overall: ${ok ? "PASS" : "FAIL"}`);
  lines.push("");

  const report = lines.join("\n");
  console.log(report);
  writeFileSync(resolve(EVAL_ROOT, "report.md"), report);

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
