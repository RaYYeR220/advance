import type { Address } from "viem";

export type LlmBehavior =
  /** A no-op "approve" memo: capMultiplierBps 10000, floorCentsDelta 0 — accepts the
   * engine's proposal exactly as computed. */
  | { kind: "auto" }
  /** A scripted tighten (or a deny-regardless-of-numbers via verdict "deny"). */
  | { kind: "tighten"; capMultiplierBps: number; floorCentsDelta: number }
  | { kind: "deny" }
  /** Simulates an LLM that literally complies with an injected instruction embedded in
   * the untrusted token name/symbol, asking it to loosen terms beyond what's allowed. */
  | { kind: "obedientInjection"; capMultiplierBps: number; floorCentsDelta: number }
  /** Non-JSON / schema-invalid response text. */
  | { kind: "garbage" }
  /** Rejects immediately with a timeout-shaped error (no real 15s wait). */
  | { kind: "timeout" };

/**
 * Explicit swap-address distribution a scenario asks `fakes.ts` to generate — never a
 * hand-picked target ratio. `washCount` swaps go to the creator; `whaleCounts` (each > 0,
 * at most 4 entries) go to that many distinct "whale" addresses; every remaining swap
 * (`swapCount - washCount - sum(whaleCounts)`) goes to a unique one-off long-tail address.
 * The realized top-5 concentration count is *derived* from this via
 * `swapMix.ts`'s `realizedTop5Count` — see its doc comment for why a long tail can inflate
 * it beyond `washCount + sum(whaleCounts)` when fewer than 5 named addresses are active.
 */
export interface SwapMix {
  swapCount: number;
  washCount: number;
  whaleCounts: number[];
}

export interface ScenarioParams {
  id: string;
  category: string;
  description: string;
  chainId: 8453 | 84532;
  network: "mainnet" | "demo";
  /** Seconds; must be even (exact at the fake chain's 2s/block). */
  ageSeconds: bigint;
  /** Pool-wide WETH fee accrual, wei, length exactly 30. Index 0 = the most recent day
   * (yesterday-through-today), index 29 = 30 days ago. */
  dailyFeesWei: bigint[];
  creatorSharesWad: bigint;
  /** Chainlink-shaped 8-decimal ETH/USD answer. */
  ethUsdAnswerE8: bigint;
  /** How stale the ETH/USD round is as of latest (must stay <= 3600s to be usable). */
  ethUsdStalenessSeconds: bigint;
  swaps: SwapMix;
  isWethPool: boolean;
  poolLocked: boolean;
  hookGraduationFlag: boolean;
  tokenName: string;
  tokenSymbol: string;
  llm: LlmBehavior;
  /** Base mainnet consults both Bankr + Airlock; every other chain is Airlock-only. */
  discoveryMode: "both" | "airlockOnly";
}

export interface ResolvedAddresses {
  token: Address;
  creator: Address;
  numeraire: Address;
  dopplerHook: Address;
}
