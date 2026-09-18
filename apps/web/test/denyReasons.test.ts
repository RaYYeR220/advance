import { describe, expect, it } from "vitest";
import { DENY_REASON_COPY, exhibitLetter } from "@/lib/denyReasons";

const ALL_REASONS = [
  "not_bankr_doppler",
  "not_weth_pool",
  "pool_not_locked",
  "creator_has_no_shares",
  "already_escrowed",
  "too_young",
  "no_recent_revenue",
  "wash_trading",
  "concentrated_flow",
  "below_minimum",
  "memo_denied",
  "memo_unavailable",
  "data_unavailable",
] as const;

describe("DENY_REASON_COPY", () => {
  it("has a non-empty title and body for every deny reason", () => {
    for (const reason of ALL_REASONS) {
      const copy = DENY_REASON_COPY[reason];
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });

  it("never repeats the same title across reasons", () => {
    const titles = ALL_REASONS.map((r) => DENY_REASON_COPY[r].title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("exhibitLetter", () => {
  it("letters exhibits A, B, C, ...", () => {
    expect(exhibitLetter(0)).toBe("A");
    expect(exhibitLetter(1)).toBe("B");
    expect(exhibitLetter(25)).toBe("Z");
  });

  it("wraps past Z rather than throwing", () => {
    expect(exhibitLetter(26)).toBe("A");
  });
});
