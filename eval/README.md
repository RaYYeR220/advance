# @advance/eval

A graded eval for `@advance/core`'s underwriting engine: 36 scenarios, an answer key derived
independently of the engine's own code, and a scorecard the engine either passes or doesn't.

## Run it

```
pnpm --filter @advance/eval start
```

Builds `@advance/core`, builds this package, runs every scenario through the real
`underwrite()`, grades each decision against `answer-key.json`, prints the scorecard, and
writes `report.md`. Exits non-zero if any hard invariant is violated or any graded metric
(decision accuracy, deny-reason precision/recall, approvals-within-band) is under 100%.

## How a scenario becomes an engine input

Nothing here is hand-authored fixture JSON. `src/gen.ts` builds 36 `ScenarioParams` objects
(daily WETH fee-accrual series, swap-address mix, creator shares, token age, ETH/USD price,
pool status/hook flags, pairing, chain id, LLM behavior). `src/fakes.ts` turns each into a
fully in-memory `ChainOps` + `BankrClient` implementing the exact interfaces
`@advance/core`'s `underwrite()`/`score()` take as deps — no recorded RPC calls, no network.
`src/llmFakes.ts` scripts the memo-stage `LlmClient` per scenario: a clean no-op approve, a
legitimate tighten, an outright deny, an "obedient" model that echoes a prompt-injection
payload asking to loosen terms, a non-JSON response, and a timeout-shaped rejection.
`eval/scenarios/*.json` is a snapshot of the generated parameters, written by
`derive-key` for audit purposes — `run.ts` never reads it; it calls `gen.ts` directly.

## The answer key

`answer-key.json` holds, per scenario, the expected decision kind, the expected deny-reason
set, and (for approvals) a `[minCap,maxCap]` micro-USD band plus the pre-memo formula
cap/floor/drawLimit. It's built by `pnpm --filter @advance/eval run derive-key`, which runs
`src/deriveKey.ts` against `src/independentFormula.ts` — a from-scratch reimplementation of
the "Binding formulas" spec that never imports `@advance/core`'s
`underwrite/{terms,quality,rules}.ts`. `answer-key.derivation.md`
documents the arithmetic (r1/r7/r30, decay, haircut steps, rawCap, cap, floor, draw terms)
for every scenario. `run.ts` is the only file that reads `answer-key.json`; it never imports
`deriveKey.ts` or `independentFormula.ts`.

If a scenario ever disagrees with the engine, re-derive it by hand first. If the key turns
out to be wrong against the formula spec, fix `gen.ts`/`independentFormula.ts` and note the
correction in `answer-key.derivation.md` — never patch `answer-key.json` by hand, always
regenerate it. If the engine turns out to be wrong, that's an engine bug, not a key problem.

## Scenario categories (36 total)

healthy steady (5), decaying (5), spiky (3), wash-traded (4, 2 haircut-only + 2 deny),
concentrated flow (3, 2 haircut-only + 1 deny), too young (2), no recent revenue (2),
BNKR-paired / non-WETH (2), prompt-injection with an obedient LLM (3), LLM garbage/timeout
(2), a negative control (1, identical to healthy-1 except creator shares 0), Base Sepolia /
Airlock-only discovery (2), a heavy memo tighten that pushes below the $1 minimum (1), and a
Doppler-hook graduation flag that denies pool_not_locked (1).

## Tests

`pnpm --filter @advance/eval test` covers `src/fakes.ts`'s non-trivial parts: the
block/timestamp model, fee-accrual deltas matching the configured daily series exactly, pool
shape (WETH pairing, lock status, graduation flag), the realized swap-address mix (including
the "long tail can backfill the top-5 ranking" subtlety `swapMix.ts` accounts for), the fake
Bankr client's pool-id binding, and a couple of `score()` integration sanity checks
independent of `answer-key.json`.
