import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { AgentEvent } from "@/lib/events";
import { groupRefusalsByLayer, REFUSAL_LAYERS, toLoanRefusal, totalRefusals } from "@/lib/refusals";

const PAYEE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX: Hex = `0x${"7".repeat(64)}` as Hex;

function refusalEvent(overrides: Partial<AgentEvent> & { data?: Record<string, unknown> } = {}): AgentEvent {
  return {
    source: "agent",
    id: overrides.id ?? "evt-1",
    type: "refusal",
    timestamp: overrides.timestamp ?? 1_700_000_000,
    data: { layer: "gateway", reason: "payee off the allowlist", ...overrides.data },
    ...overrides,
  };
}

describe("toLoanRefusal", () => {
  it("reads a well-formed refusal", () => {
    const refusal = toLoanRefusal(
      refusalEvent({ id: "r1", data: { layer: "card-1271", reason: "off allowlist", payTo: PAYEE, amount: "12.50" }, txHash: TX }),
    );
    expect(refusal).toEqual({ id: "r1", timestamp: 1_700_000_000, layer: "card-1271", reason: "off allowlist", payTo: PAYEE, amount: "12.50", txHash: TX });
  });

  it("ignores an event that isn't a refusal", () => {
    expect(toLoanRefusal(refusalEvent({ type: "receipt" }))).toBeUndefined();
  });

  it("drops a refusal with an unrecognized layer rather than fabricating a bucket", () => {
    expect(toLoanRefusal(refusalEvent({ data: { layer: "mempool", reason: "x" } }))).toBeUndefined();
  });

  it("drops a refusal with no reason", () => {
    expect(toLoanRefusal(refusalEvent({ data: { layer: "gateway" } }))).toBeUndefined();
  });

  it("drops a malformed payTo instead of guessing an address", () => {
    const refusal = toLoanRefusal(refusalEvent({ data: { layer: "gateway", reason: "x", payTo: "not-an-address" } }));
    expect(refusal?.payTo).toBeUndefined();
  });

  it("accepts a numeric amount by stringifying it", () => {
    const refusal = toLoanRefusal(refusalEvent({ data: { layer: "dynamic", reason: "x", amount: 42 } }));
    expect(refusal?.amount).toBe("42");
  });
});

describe("groupRefusalsByLayer", () => {
  it("buckets every recognized layer, newest first, and always includes all four layers", () => {
    const events: AgentEvent[] = [
      refusalEvent({ id: "a", timestamp: 100, data: { layer: "gateway", reason: "x" } }),
      refusalEvent({ id: "b", timestamp: 300, data: { layer: "gateway", reason: "y" } }),
      refusalEvent({ id: "c", timestamp: 200, data: { layer: "credit-line", reason: "z" } }),
      refusalEvent({ id: "d", timestamp: 50, type: "receipt", data: { payee: PAYEE } }), // not a refusal
    ];
    const grouped = groupRefusalsByLayer(events);
    expect(Object.keys(grouped).sort()).toEqual([...REFUSAL_LAYERS].sort());
    expect(grouped.gateway.map((r) => r.id)).toEqual(["b", "a"]);
    expect(grouped["credit-line"].map((r) => r.id)).toEqual(["c"]);
    expect(grouped["card-1271"]).toEqual([]);
    expect(grouped.dynamic).toEqual([]);
  });

  it("returns every layer empty for no refusals, never omitting a layer", () => {
    const grouped = groupRefusalsByLayer([]);
    for (const layer of REFUSAL_LAYERS) expect(grouped[layer]).toEqual([]);
    expect(totalRefusals(grouped)).toBe(0);
  });
});

describe("totalRefusals", () => {
  it("sums every layer", () => {
    const grouped = groupRefusalsByLayer([
      refusalEvent({ id: "a", data: { layer: "gateway", reason: "x" } }),
      refusalEvent({ id: "b", data: { layer: "dynamic", reason: "y" } }),
    ]);
    expect(totalRefusals(grouped)).toBe(2);
  });
});
