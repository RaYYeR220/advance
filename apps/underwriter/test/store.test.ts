import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvidenceBundle } from "@advance/core";
import { createFileEvidenceStore } from "../src/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "advance-evidence-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hashOf(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

function fakeBundle(tag: string): EvidenceBundle {
  return { tag } as unknown as EvidenceBundle;
}

function jsonFileCount(): number {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}

describe("createFileEvidenceStore: TTL", () => {
  it("expires an entry once its TTL has passed, sweeping it off disk on the next save", () => {
    let t = 1_000_000;
    const store = createFileEvidenceStore(dir, { now: () => t, ttlMs: 1_000, maxEntries: 100 });

    const hashA = hashOf(0xaa);
    store.save(hashA, fakeBundle("a"));
    expect(store.get(hashA)).toBeDefined();

    t += 1_001; // just past the 1000ms TTL
    const hashB = hashOf(0xbb);
    store.save(hashB, fakeBundle("b")); // triggers the sweep

    expect(store.get(hashA)).toBeUndefined();
    expect(store.get(hashB)).toBeDefined();
    expect(jsonFileCount()).toBe(1);
  });

  it("does not evict an entry still within its TTL", () => {
    let t = 1_000_000;
    const store = createFileEvidenceStore(dir, { now: () => t, ttlMs: 10_000, maxEntries: 100 });

    const hashA = hashOf(0xaa);
    store.save(hashA, fakeBundle("a"));

    t += 5_000; // well within the 10000ms TTL
    store.save(hashOf(0xbb), fakeBundle("b"));

    expect(store.get(hashA)).toBeDefined();
    expect(jsonFileCount()).toBe(2);
  });
});

describe("createFileEvidenceStore: cap", () => {
  it("evicts the oldest-saved entry once over the cap", () => {
    let t = 1_000_000;
    const store = createFileEvidenceStore(dir, { now: () => t, ttlMs: 10 ** 9, maxEntries: 2 });

    const hashA = hashOf(0xaa);
    const hashB = hashOf(0xbb);
    const hashC = hashOf(0xcc);

    store.save(hashA, fakeBundle("a"));
    t += 1;
    store.save(hashB, fakeBundle("b"));
    t += 1;
    store.save(hashC, fakeBundle("c")); // 3rd entry over a cap of 2 — evicts "a" (oldest)

    expect(store.get(hashA)).toBeUndefined();
    expect(store.get(hashB)).toBeDefined();
    expect(store.get(hashC)).toBeDefined();
    expect(jsonFileCount()).toBe(2);
  });

  it("re-saving an existing hash is idempotent and never triggers a sweep", () => {
    let t = 1_000_000;
    const store = createFileEvidenceStore(dir, { now: () => t, ttlMs: 10 ** 9, maxEntries: 1 });

    const hashA = hashOf(0xaa);
    store.save(hashA, fakeBundle("a"));
    store.save(hashA, fakeBundle("a-again")); // no-op: same hash, already on disk

    expect(jsonFileCount()).toBe(1);
    const stored = store.get(hashA) as { tag: string };
    expect(stored.tag).toBe("a"); // untouched by the second, ignored save
  });
});

describe("createFileEvidenceStore: get", () => {
  it("returns undefined for an unknown or malformed hash", () => {
    const store = createFileEvidenceStore(dir);
    expect(store.get(hashOf(0x99))).toBeUndefined();
    expect(store.get("not-a-hash" as Hex)).toBeUndefined();
  });
});
