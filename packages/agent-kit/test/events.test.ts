import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/events.js";
import { FileStore } from "../src/store.js";

let dir: string;
let store: FileStore;
let events: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-kit-events-"));
  store = new FileStore(dir);
  events = new EventStore(store);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EventStore", () => {
  it("persists an appended event with an assigned ts", async () => {
    const before = Date.now();
    await events.append({ agent: "alice", kind: "refusal", data: { reason: "test" } });
    const all = await events.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.agent).toEqual("alice");
    expect(all[0]!.kind).toEqual("refusal");
    expect(all[0]!.data).toEqual({ reason: "test" });
    expect(all[0]!.ts).toBeGreaterThanOrEqual(before);
    expect(all[0]!.txHash).toBeUndefined();
  });

  it("uses a caller-supplied ts instead of generating one", async () => {
    await events.append({ agent: "alice", kind: "refusal", data: {}, ts: 12345 });
    const all = await events.list();
    expect(all[0]!.ts).toEqual(12345);
  });

  it("carries txHash through when present", async () => {
    await events.append({ agent: "alice", kind: "receipt", data: {}, txHash: "0xdead" });
    const all = await events.list();
    expect(all[0]!.txHash).toEqual("0xdead");
  });

  it("lists multiple events in timestamp order regardless of insertion order", async () => {
    await events.append({ agent: "a", kind: "k", data: {}, ts: 300 });
    await events.append({ agent: "b", kind: "k", data: {}, ts: 100 });
    await events.append({ agent: "c", kind: "k", data: {}, ts: 200 });
    const all = await events.list();
    expect(all.map((e) => e.agent)).toEqual(["b", "c", "a"]);
  });

  it("returns an empty list when nothing has been appended", async () => {
    expect(await events.list()).toEqual([]);
  });

  it("never leaks a shared key across two events appended in the same millisecond", async () => {
    await Promise.all([
      events.append({ agent: "a", kind: "k", data: { i: 1 }, ts: 1000 }),
      events.append({ agent: "a", kind: "k", data: { i: 2 }, ts: 1000 }),
    ]);
    const all = await events.list();
    expect(all).toHaveLength(2);
  });
});
