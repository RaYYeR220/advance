import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@advance/agent-kit";
import { computeBurnRate, decideRunwayAction, DEFAULT_RUNWAY_MIN_TICKS, type RunwayObservation } from "../../src/brain/policy.js";

function receipt(agent: string, amount: string, ts: number): AgentEvent {
  return { ts, agent, kind: "receipt", data: { amount } };
}

describe("computeBurnRate", () => {
  it("is zero with no spend history", () => {
    expect(computeBurnRate([], "alice")).toBe(0n);
  });

  it("equals the single receipt amount when there's only one", () => {
    const events = [receipt("alice", "1000", 1)];
    expect(computeBurnRate(events, "alice")).toBe(1000n);
  });

  it("computes a 3/10-weighted EMA over multiple receipts, oldest first", () => {
    // ema0 = 1000; ema1 = (3*2000 + 7*1000)/10 = 1300; ema2 = (3*3000 + 7*1300)/10 = 1810
    const events = [receipt("alice", "1000", 1), receipt("alice", "2000", 2), receipt("alice", "3000", 3)];
    expect(computeBurnRate(events, "alice")).toBe(1810n);
  });

  it("ignores events for other agents and non-receipt kinds", () => {
    const events: AgentEvent[] = [
      receipt("bob", "5000", 1),
      receipt("alice", "1000", 2),
      { ts: 3, agent: "alice", kind: "refusal", data: { amount: "9999" } },
    ];
    expect(computeBurnRate(events, "alice")).toBe(1000n);
  });

  it("sorts by timestamp before folding, regardless of input order", () => {
    const events = [receipt("alice", "3000", 3), receipt("alice", "1000", 1), receipt("alice", "2000", 2)];
    expect(computeBurnRate(events, "alice")).toBe(1810n);
  });
});

const TASK_COST = 1000n;

function obs(overrides: Partial<RunwayObservation> = {}): RunwayObservation {
  return {
    cardUsdcBalance: 1_000_000n,
    burnRatePerTick: 1000n,
    hasActiveLoan: false,
    creditLineAvailable: 0n,
    ...overrides,
  };
}

describe("decideRunwayAction", () => {
  it("does nothing when runway is comfortably long and there's no active loan", () => {
    const decision = decideRunwayAction(obs(), { taskCostUsdc: TASK_COST, runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS });
    expect(decision).toEqual({ action: "none" });
  });

  it("borrows when ticks-of-runway drop below the minimum", () => {
    // balance/burn = 2 ticks < min (3)
    const decision = decideRunwayAction(obs({ cardUsdcBalance: 2000n, burnRatePerTick: 1000n }), {
      taskCostUsdc: TASK_COST,
      runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS,
    });
    expect(decision).toEqual({ action: "borrow" });
  });

  it("borrows on a cold start (zero balance, no burn history yet)", () => {
    const decision = decideRunwayAction(obs({ cardUsdcBalance: 0n, burnRatePerTick: 0n }), {
      taskCostUsdc: TASK_COST,
      runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS,
    });
    expect(decision).toEqual({ action: "borrow" });
  });

  it("never borrows again once a loan is already active, even if runway is short", () => {
    const decision = decideRunwayAction(
      obs({ cardUsdcBalance: 100n, burnRatePerTick: 1000n, hasActiveLoan: true, creditLineAvailable: 0n }),
      { taskCostUsdc: TASK_COST, runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS },
    );
    expect(decision).toEqual({ action: "none" });
  });

  it("draws the full available amount when an active loan's card balance can't cover one task", () => {
    const decision = decideRunwayAction(
      obs({ cardUsdcBalance: 500n, hasActiveLoan: true, creditLineAvailable: 50_000n }),
      { taskCostUsdc: TASK_COST, runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS },
    );
    expect(decision).toEqual({ action: "draw", amount: 50_000n });
  });

  it("does nothing (fails closed) when the draw period is already exhausted", () => {
    const decision = decideRunwayAction(
      obs({ cardUsdcBalance: 500n, hasActiveLoan: true, creditLineAvailable: 0n }),
      { taskCostUsdc: TASK_COST, runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS },
    );
    expect(decision).toEqual({ action: "none" });
  });

  it("does not draw when the active loan's card balance already covers one task", () => {
    const decision = decideRunwayAction(
      obs({ cardUsdcBalance: TASK_COST, hasActiveLoan: true, creditLineAvailable: 50_000n }),
      { taskCostUsdc: TASK_COST, runwayMinTicks: DEFAULT_RUNWAY_MIN_TICKS },
    );
    expect(decision).toEqual({ action: "none" });
  });
});
