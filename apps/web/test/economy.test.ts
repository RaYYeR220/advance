import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { EconomyAgent } from "@/lib/data";
import { agentCardData, lastActionLabel, runwayData, sortAgentCards, type AgentCardData } from "@/lib/economy";

const AGENT: Address = "0x1111111111111111111111111111111111111111";
const CARD: Address = "0x2222222222222222222222222222222222222222";

function fakeAgent(overrides: Partial<EconomyAgent> = {}): EconomyAgent {
  return {
    agentTreasury: AGENT,
    agentCard: CARD,
    agentId: 1n,
    loanId: 1n,
    status: "Active",
    cap: 500_000_000n,
    repaid: 100_000_000n,
    drawn: 40_000_000n,
    available: 10_000_000n,
    runwaySeconds: 5n * 86_400n,
    gracePeriodSeconds: 14n * 86_400n,
    revenue7dUsdc: 25_000_000n,
    lastEventAt: 1_700_000_000,
    lastEventType: "Harvested",
    ...overrides,
  };
}

describe("runwayData", () => {
  it("computes the ratio against the grace period", () => {
    const data = runwayData(fakeAgent());
    expect(data?.ratio).toBeCloseTo(5 / 14);
    expect(data?.label).toBe("5d");
  });

  it("is null for a loan that isn't Active", () => {
    expect(runwayData(fakeAgent({ runwaySeconds: null }))).toBeNull();
  });

  it("is null when the grace period is zero", () => {
    expect(runwayData(fakeAgent({ gracePeriodSeconds: 0n }))).toBeNull();
  });

  it("clamps the ratio to 1 even if runway somehow exceeds the grace period", () => {
    const data = runwayData(fakeAgent({ runwaySeconds: 20n * 86_400n, gracePeriodSeconds: 14n * 86_400n }));
    expect(data?.ratio).toBe(1);
  });
});

describe("lastActionLabel", () => {
  it("humanizes known event types", () => {
    expect(lastActionLabel("Harvested")).toBe("Escrow harvest");
    expect(lastActionLabel("refusal")).toBe("Payment refused");
  });

  it("falls back to the raw type for an unrecognized event", () => {
    expect(lastActionLabel("something_new")).toBe("something_new");
  });

  it("is null when there is no event at all", () => {
    expect(lastActionLabel(null)).toBeNull();
  });
});

describe("agentCardData", () => {
  it("converts every amount to USD and carries the runway/last action", () => {
    const card = agentCardData(fakeAgent());
    expect(card.capUsd).toBe(500);
    expect(card.repaidUsd).toBe(100);
    expect(card.revenue7dUsd).toBe(25);
    expect(card.runway?.ratio).toBeCloseTo(5 / 14);
    expect(card.lastAction).toEqual({ label: "Escrow harvest", timestamp: 1_700_000_000 });
  });

  it("has no last action when nothing was ever recorded", () => {
    const card = agentCardData(fakeAgent({ lastEventType: null, lastEventAt: null }));
    expect(card.lastAction).toBeNull();
  });
});

describe("sortAgentCards", () => {
  function card(overrides: Partial<AgentCardData>): AgentCardData {
    return {
      agentTreasury: AGENT,
      loanId: 1n,
      status: "Active",
      capUsd: 0,
      repaidUsd: 0,
      drawnUsd: 0,
      availableUsd: 0,
      revenue7dUsd: 0,
      runway: null,
      lastAction: null,
      ...overrides,
    };
  }

  it("puts Active loans first, least runway first", () => {
    const urgent = card({ loanId: 1n, runway: { ratio: 0.1, label: "1d" } });
    const safe = card({ loanId: 2n, runway: { ratio: 0.9, label: "12d" } });
    const repaid = card({ loanId: 3n, status: "Repaid", lastAction: { label: "Cap repaid", timestamp: 500 } });
    const sorted = sortAgentCards([repaid, safe, urgent]);
    expect(sorted.map((c) => c.loanId)).toEqual([1n, 2n, 3n]);
  });

  it("orders non-Active loans by most recently active first", () => {
    const older = card({ loanId: 1n, status: "Repaid", lastAction: { label: "Cap repaid", timestamp: 100 } });
    const newer = card({ loanId: 2n, status: "Defaulted", lastAction: { label: "Marked in default", timestamp: 200 } });
    const sorted = sortAgentCards([older, newer]);
    expect(sorted.map((c) => c.loanId)).toEqual([2n, 1n]);
  });
});
