/**
 * Builds `eval/answer-key.json` + `eval/answer-key.derivation.md` from scratch —
 * independently of the engine. Uses only `gen.ts` (the scenario parameters) and
 * `independentFormula.ts` (a fresh reimplementation of the binding formula spec, written
 * without importing `@advance/core`'s `underwrite/{terms,quality,rules}.ts`). `run.ts`
 * never imports this file or `independentFormula.ts` — it only reads the committed JSON.
 *
 * Run via `pnpm --filter @advance/eval run derive-key`. Re-run whenever `gen.ts`'s
 * scenario parameters change; the derivation file documents the arithmetic behind every
 * approved scenario's cap band.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerKey, AnswerKeyEntry } from "./answerKeyTypes.js";
import { buildScenarios } from "./gen.js";
import { applyIndependentMemo, computeIndependentFormula, type IndependentFormulaResult } from "./independentFormula.js";
import type { ScenarioParams } from "./types.js";

// This module is compiled to eval/dist/src/deriveKey.js — two levels below eval/.
const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = resolve(HERE, "../..");

interface Evaluated {
  scenario: ScenarioParams;
  entry: AnswerKeyEntry;
  formula: IndependentFormulaResult | null;
  memoNote: string;
}

function bigintToStr(v: bigint): string {
  return v.toString();
}

function evaluateScenario(scenario: ScenarioParams): Evaluated {
  if (!scenario.isWethPool) {
    return {
      scenario,
      formula: null,
      memoNote: "pool-shape short circuit: numeraire is not WETH, denied before any revenue read.",
      entry: {
        category: scenario.category,
        kind: "deny",
        denyReasons: ["not_weth_pool"],
        capBandMicroUsd: null,
        formulaCapMicroUsd: null,
        formulaFloorCents: null,
        formulaDrawLimitMicroUsd: null,
      },
    };
  }

  if (!scenario.poolLocked || scenario.hookGraduationFlag) {
    return {
      scenario,
      formula: null,
      memoNote: "pool-shape short circuit: pool not Locked or its hook allows graduation, denied before any revenue read.",
      entry: {
        category: scenario.category,
        kind: "deny",
        denyReasons: ["pool_not_locked"],
        capBandMicroUsd: null,
        formulaCapMicroUsd: null,
        formulaFloorCents: null,
        formulaDrawLimitMicroUsd: null,
      },
    };
  }

  const formula = computeIndependentFormula(scenario);

  if (formula.ruleDenyReasons.length > 0) {
    return {
      scenario,
      formula,
      memoNote: "hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.",
      entry: {
        category: scenario.category,
        kind: "deny",
        denyReasons: [...formula.ruleDenyReasons].sort(),
        capBandMicroUsd: null,
        formulaCapMicroUsd: bigintToStr(formula.capMicroUsd),
        formulaFloorCents: formula.floorCents,
        formulaDrawLimitMicroUsd: bigintToStr(formula.drawLimit),
      },
    };
  }

  // Approve-eligible pre-memo. Apply the scripted memo's numeric effect.
  const base = {
    formulaCapMicroUsd: bigintToStr(formula.capMicroUsd),
    formulaFloorCents: formula.floorCents,
    formulaDrawLimitMicroUsd: bigintToStr(formula.drawLimit),
  };

  switch (scenario.llm.kind) {
    case "auto": {
      const cap = bigintToStr(formula.capMicroUsd);
      return {
        scenario,
        formula,
        memoNote: "no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.",
        entry: {
          category: scenario.category,
          kind: "approve",
          denyReasons: [],
          capBandMicroUsd: [cap, cap],
          ...base,
        },
      };
    }
    case "obedientInjection":
    case "tighten": {
      const { capMultiplierBps, floorCentsDelta } = scenario.llm;
      const merged = applyIndependentMemo(formula, capMultiplierBps, floorCentsDelta);
      if (merged.belowMinimum) {
        return {
          scenario,
          formula,
          memoNote: `memo tighten (capMultiplierBps=${capMultiplierBps}, floorCentsDelta=${floorCentsDelta}) pushes minPrincipal (${merged.minPrincipal}) under $1 -> deny below_minimum.`,
          entry: {
            category: scenario.category,
            kind: "deny",
            denyReasons: ["below_minimum"],
            capBandMicroUsd: null,
            ...base,
          },
        };
      }
      const cap = bigintToStr(merged.capMicroUsd);
      return {
        scenario,
        formula,
        memoNote:
          scenario.llm.kind === "obedientInjection"
            ? `memo asked for capMultiplierBps=${capMultiplierBps}, floorCentsDelta=${floorCentsDelta} (a loosening attempt) — clamped to [0,10000]/[>=0], so the final terms equal the pre-memo formula terms exactly.`
            : `memo tighten (capMultiplierBps=${capMultiplierBps}, floorCentsDelta=${floorCentsDelta}) -> cap ${cap}, floor ${merged.floorCents}, drawLimit ${merged.drawLimit}.`,
        entry: {
          category: scenario.category,
          kind: "approve",
          denyReasons: [],
          capBandMicroUsd: [cap, cap],
          ...base,
        },
      };
    }
    case "deny": {
      return {
        scenario,
        formula,
        memoNote: "memo verdict is deny regardless of multiplier/delta -> deny memo_denied.",
        entry: {
          category: scenario.category,
          kind: "deny",
          denyReasons: ["memo_denied"],
          capBandMicroUsd: null,
          ...base,
        },
      };
    }
    case "garbage":
    case "timeout": {
      return {
        scenario,
        formula,
        memoNote: `${scenario.llm.kind} response from the LLM -> deny memo_unavailable.`,
        entry: {
          category: scenario.category,
          kind: "deny",
          denyReasons: ["memo_unavailable"],
          capBandMicroUsd: null,
          ...base,
        },
      };
    }
  }
}

function fmtMicroUsd(v: bigint): string {
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `$${sign}${whole}.${frac} (${v} micro-USD)`;
}

function renderDerivation(evaluations: Evaluated[]): string {
  const lines: string[] = [];
  lines.push("# Answer key derivation");
  lines.push("");
  lines.push(
    "Independent re-derivation of every scenario's expected decision from the Task 3 " +
      '"Binding formulas" spec, computed by `eval/src/independentFormula.ts` (written fresh ' +
      "from the spec text, never importing `@advance/core`'s `underwrite/{terms,quality,rules}.ts`) " +
      "against the scenario parameters in `eval/src/gen.ts`. Regenerate with " +
      "`pnpm --filter @advance/eval run derive-key`.",
  );
  lines.push("");

  for (const ev of evaluations) {
    const s = ev.scenario;
    lines.push(`## ${s.id} (${s.category})`);
    lines.push("");
    lines.push(s.description);
    lines.push("");
    lines.push(`- chainId ${s.chainId}, network ${s.network}, ageSeconds ${s.ageSeconds}`);
    lines.push(
      `- isWethPool=${s.isWethPool} poolLocked=${s.poolLocked} hookGraduationFlag=${s.hookGraduationFlag}`,
    );
    if (ev.formula) {
      const f = ev.formula;
      lines.push(
        `- revenueMicroUsd: d1=${f.revenueMicroUsd.d1} d7=${f.revenueMicroUsd.d7} d30=${f.revenueMicroUsd.d30}`,
      );
      lines.push(`- r1=${f.r1} r7=${f.r7} r30=${f.r30} -> base=${f.base}`);
      lines.push(`- decayBps=${f.decayBps} -> q=${f.q.toFixed(6)}, sumQ(90 terms)=${f.sumQ.toFixed(6)}`);
      lines.push(`- projected90dMicroUsd = floor(${f.base} * ${f.sumQ.toFixed(6)}) = ${f.projected90dMicroUsd}`);
      lines.push(
        `- top5ConcentrationRatio=${f.top5ConcentrationRatio.toFixed(4)} washRatio=${f.washRatio.toFixed(4)} cv=${
          f.cv === undefined ? "undefined" : f.cv.toFixed(4)
        }`,
      );
      lines.push(
        `- haircutBps steps: concentration=${f.haircutSteps.concentration} wash=${f.haircutSteps.wash} age=${f.haircutSteps.age} cv=${f.haircutSteps.cv} -> haircutBps=${f.haircutBps}`,
      );
      lines.push(`- rawCap = projected90*5000/10000*haircut/10000 = ${f.rawCap}`);
      lines.push(
        `- hardCeilingMicroUsd=${f.hardCeilingMicroUsd} -> capMicroUsd=${f.capMicroUsd} = ${fmtMicroUsd(f.capMicroUsd)}`,
      );
      lines.push(`- floorCents=${f.floorCents}, minPrincipal=${f.minPrincipal}, drawLimit=${f.drawLimit}`);
      if (f.ruleDenyReasons.length > 0) {
        lines.push(`- rule deny reasons: ${f.ruleDenyReasons.join(", ")}`);
      }
    }
    lines.push(`- memo: ${JSON.stringify(s.llm)}`);
    lines.push(`- ${ev.memoNote}`);
    lines.push("");
    lines.push(
      `**Expected**: kind=${ev.entry.kind}${
        ev.entry.denyReasons.length > 0 ? `, reasons=[${ev.entry.denyReasons.join(", ")}]` : ""
      }${ev.entry.capBandMicroUsd ? `, capBand=[${ev.entry.capBandMicroUsd.join(", ")}]` : ""}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function scenarioToJson(s: ScenarioParams): unknown {
  return {
    ...s,
    ageSeconds: s.ageSeconds.toString(),
    dailyFeesWei: s.dailyFeesWei.map((v) => v.toString()),
    creatorSharesWad: s.creatorSharesWad.toString(),
    ethUsdAnswerE8: s.ethUsdAnswerE8.toString(),
    ethUsdStalenessSeconds: s.ethUsdStalenessSeconds.toString(),
  };
}

function main(): void {
  const scenarios = buildScenarios();
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id: ${s.id}`);
    ids.add(s.id);
  }

  const evaluations = scenarios.map(evaluateScenario);

  const answerKey: AnswerKey = {};
  for (const ev of evaluations) answerKey[ev.scenario.id] = ev.entry;

  writeFileSync(resolve(EVAL_ROOT, "answer-key.json"), `${JSON.stringify(answerKey, null, 2)}\n`);
  writeFileSync(resolve(EVAL_ROOT, "answer-key.derivation.md"), renderDerivation(evaluations));

  mkdirSync(resolve(EVAL_ROOT, "scenarios"), { recursive: true });
  for (const s of scenarios) {
    writeFileSync(
      resolve(EVAL_ROOT, "scenarios", `${s.id}.json`),
      `${JSON.stringify(scenarioToJson(s), null, 2)}\n`,
    );
  }

  const approvals = evaluations.filter((e) => e.entry.kind === "approve").length;
  const denies = evaluations.filter((e) => e.entry.kind === "deny").length;
  console.log(
    `derived answer key for ${scenarios.length} scenarios (${approvals} approve, ${denies} deny) -> answer-key.json, answer-key.derivation.md, scenarios/*.json`,
  );
}

main();
