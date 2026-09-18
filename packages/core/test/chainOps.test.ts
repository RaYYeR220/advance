import { describe, expect, it } from "vitest";
import { isPreLockWrongPoolStatus } from "../src/sources/chainOps.js";

describe("isPreLockWrongPoolStatus", () => {
  it("is true for WrongPoolStatus(expected=Locked, actual=Uninitialized) — the verified pre-lock case", () => {
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [2, 0])).toBe(true);
  });

  it("is true when args decode as bigints (viem may return uint8 args as bigint too)", () => {
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [2n, 0n])).toBe(true);
  });

  it("is false for any other actual status (Initialized/Graduated/Exited) — must not swallow", () => {
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [2, 1])).toBe(false); // Initialized
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [2, 3])).toBe(false); // Graduated
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [2, 4])).toBe(false); // Exited
  });

  it("is false for an unexpected 'expected' status even if actual is Uninitialized", () => {
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [1, 0])).toBe(false);
  });

  it("is false for a different error entirely", () => {
    expect(isPreLockWrongPoolStatus("SomeOtherError", [2, 0])).toBe(false);
  });

  it("is false when errorName or args are missing/malformed", () => {
    expect(isPreLockWrongPoolStatus(undefined, [2, 0])).toBe(false);
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", undefined)).toBe(false);
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [2])).toBe(false);
    expect(isPreLockWrongPoolStatus("WrongPoolStatus", [])).toBe(false);
  });
});
