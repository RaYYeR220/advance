import { describe, expect, it } from "vitest";
import { sweepAndCap } from "../src/ttlMap.js";

interface Entry {
  expiresAt: number;
}

describe("sweepAndCap", () => {
  it("removes only entries whose expiry has passed", () => {
    const map = new Map<string, Entry>([
      ["a", { expiresAt: 100 }],
      ["b", { expiresAt: 200 }],
      ["c", { expiresAt: 300 }],
    ]);

    sweepAndCap(map, 150, 10, (v) => v.expiresAt);

    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  it("evicts the oldest (first-inserted) entries once over the cap, after expiry sweeping", () => {
    const map = new Map<string, Entry>([
      ["a", { expiresAt: 1_000 }],
      ["b", { expiresAt: 1_000 }],
      ["c", { expiresAt: 1_000 }],
      ["d", { expiresAt: 1_000 }],
    ]);

    sweepAndCap(map, 0, 2, (v) => v.expiresAt);

    expect(map.size).toBe(2);
    expect([...map.keys()]).toEqual(["c", "d"]);
  });

  it("is a no-op when nothing is expired and the map is at or under the cap", () => {
    const map = new Map<string, Entry>([
      ["a", { expiresAt: 1_000 }],
      ["b", { expiresAt: 1_000 }],
    ]);

    sweepAndCap(map, 0, 5, (v) => v.expiresAt);

    expect([...map.keys()]).toEqual(["a", "b"]);
  });

  it("handles an empty map without error", () => {
    const map = new Map<string, Entry>();
    expect(() => sweepAndCap(map, 0, 5, (v) => v.expiresAt)).not.toThrow();
    expect(map.size).toBe(0);
  });
});
