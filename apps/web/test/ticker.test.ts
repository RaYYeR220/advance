import { describe, expect, it } from "vitest";
import { tickerEntriesFromEvents, tickerEntryFromEvent, type JsonEventLike } from "@/lib/ticker";

describe("tickerEntryFromEvent", () => {
  it("builds a chain event's id from its transaction hash and log index", () => {
    const event: JsonEventLike = { source: "chain", type: "Harvested", timestamp: 100, transactionHash: "0xabc", logIndex: 2, usdcOut: "70000000" };
    const entry = tickerEntryFromEvent(event);
    expect(entry.id).toBe("0xabc:2");
    expect(entry.label).toBe("Escrow harvest");
    expect(entry.detail).toBe("$70.00");
  });

  it("uses an off-chain event's own id", () => {
    const event: JsonEventLike = { source: "agent", type: "refusal", timestamp: 100, id: "refusal-1", loanId: "2" };
    const entry = tickerEntryFromEvent(event);
    expect(entry.id).toBe("refusal-1");
    expect(entry.label).toBe("Payment refused");
    expect(entry.loanId).toBe("2");
  });

  it("falls back to the raw type string for an unrecognized event type", () => {
    const event: JsonEventLike = { source: "agent", type: "something_new", timestamp: 100, id: "x" };
    expect(tickerEntryFromEvent(event).label).toBe("something_new");
  });

  it("reads an amount from a nested data object for off-chain receipts", () => {
    const event: JsonEventLike = { source: "agent", type: "receipt", timestamp: 100, id: "r1", data: { amount: "2400000" } };
    expect(tickerEntryFromEvent(event).detail).toBe("$2.40");
  });

  it("has no detail when the event carries no amount", () => {
    const event: JsonEventLike = { source: "chain", type: "LoanOpened", timestamp: 100, transactionHash: "0xdef", logIndex: 0 };
    expect(tickerEntryFromEvent(event).detail).toBeUndefined();
  });

  it("never throws on a malformed amount field", () => {
    const event: JsonEventLike = { source: "chain", type: "Harvested", timestamp: 100, transactionHash: "0xdef", logIndex: 0, usdcOut: "not-a-number" };
    expect(tickerEntryFromEvent(event).detail).toBeUndefined();
  });
});

describe("tickerEntriesFromEvents", () => {
  it("caps the result at the given limit, keeping order", () => {
    const events: JsonEventLike[] = Array.from({ length: 5 }, (_, i) => ({ source: "agent" as const, type: "receipt", timestamp: i, id: `r${i}` }));
    const entries = tickerEntriesFromEvents(events, 2);
    expect(entries.map((e) => e.id)).toEqual(["r0", "r1"]);
  });
});
