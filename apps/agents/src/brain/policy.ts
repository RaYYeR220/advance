import type { AgentEvent } from "@advance/agent-kit";

/** Ticks of runway an agent must have (or a loan must already be active) before the code policy
 * leaves it alone. Below this, the deterministic policy - never the model - requests a quote. */
export const DEFAULT_RUNWAY_MIN_TICKS = 3;

/** EMA smoothing weight applied to each newer receipt, as a fraction `EMA_ALPHA_NUM /
 * EMA_ALPHA_DEN` - kept as an integer ratio so the whole computation stays exact `bigint` math
 * (no floating point anywhere near a money figure). 3/10 favors history over any single spend. */
const EMA_ALPHA_NUM = 3n;
const EMA_ALPHA_DEN = 10n;

/**
 * Exponential moving average of `amounts`, oldest first: `ema[0] = amounts[0]`, then `ema[i] =
 * (alpha*amounts[i] + (1-alpha)*ema[i-1])`. Pure integer math throughout.
 */
function emaOfAmounts(amounts: readonly bigint[]): bigint {
  if (amounts.length === 0) return 0n;
  let ema = amounts[0]!;
  for (let i = 1; i < amounts.length; i++) {
    ema = (EMA_ALPHA_NUM * amounts[i]! + (EMA_ALPHA_DEN - EMA_ALPHA_NUM) * ema) / EMA_ALPHA_DEN;
  }
  return ema;
}

/**
 * Estimates one agent's per-tick spend (USDC-wei) as an EMA over its own `receipt` events (card
 * gateway payments that actually settled - see `EventStore`), oldest first by timestamp. `0n` with
 * no history yet, so a brand-new agent's runway is judged purely on its current balance (see
 * {@link decideRunwayAction}'s cold-start branch) rather than a fabricated burn rate.
 */
export function computeBurnRate(events: readonly AgentEvent[], agent: string): bigint {
  const amounts = events
    .filter((e) => e.agent === agent && e.kind === "receipt")
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((e) => BigInt(e.data["amount"] as string));
  return emaOfAmounts(amounts);
}

export interface RunwayObservation {
  /** The card's current USDC balance, USDC-wei. */
  cardUsdcBalance: bigint;
  /** {@link computeBurnRate}'s estimate, USDC-wei per tick. */
  burnRatePerTick: bigint;
  hasActiveLoan: boolean;
  /** `CreditLine.availableThisPeriod()` for the active loan; `0n` when there's no active loan. */
  creditLineAvailable: bigint;
}

export interface RunwayPolicyConfig {
  /** The canonical price of one paid action this agent performs (e.g. the x402 data/LLM price) -
   * the floor a card balance must clear to do any work at all. */
  taskCostUsdc: bigint;
  runwayMinTicks: number;
}

export type RunwayDecision = { action: "none" } | { action: "borrow" } | { action: "draw"; amount: bigint };

/**
 * The deterministic credit policy this protocol requires: code decides money, never the model. Run
 * unconditionally every tick before the agent's brain ever sees a prompt, and again (idempotently)
 * whenever the model's `request_credit` tool fires - same function, same answer, no amount or
 * payee input from anywhere but this policy and the on-chain state it reads.
 *
 * - No active loan: borrow once either the observed burn rate would exhaust the card in fewer
 *   than `runwayMinTicks`, or the balance can't even cover one task right now (a cold start with
 *   no spend history yet, where a burn-rate estimate alone would say "infinite runway").
 * - Active loan, balance short of one task: draw the full amount `CreditLine.availableThisPeriod`
 *   currently allows. Draws nothing (fails closed) when that's `0n` - a period limit or a frozen
 *   line - rather than attempting a call the contract would revert.
 * - Otherwise: nothing to do.
 */
export function decideRunwayAction(observation: RunwayObservation, config: RunwayPolicyConfig): RunwayDecision {
  const { cardUsdcBalance, burnRatePerTick, hasActiveLoan, creditLineAvailable } = observation;
  const { taskCostUsdc, runwayMinTicks } = config;

  if (!hasActiveLoan) {
    const outOfFunds = cardUsdcBalance < taskCostUsdc;
    const runwayTicks = burnRatePerTick > 0n ? Number(cardUsdcBalance / burnRatePerTick) : Number.POSITIVE_INFINITY;
    const runningLow = Number.isFinite(runwayTicks) && runwayTicks < runwayMinTicks;
    return outOfFunds || runningLow ? { action: "borrow" } : { action: "none" };
  }

  if (cardUsdcBalance < taskCostUsdc && creditLineAvailable > 0n) {
    return { action: "draw", amount: creditLineAvailable };
  }

  return { action: "none" };
}
