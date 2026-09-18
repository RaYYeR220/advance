import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../src/store.js";

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-kit-store-"));
  store = new FileStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("returns undefined for a key that was never set", async () => {
    expect(await store.get("missing")).toBeUndefined();
  });

  it("writes then reads back a value", async () => {
    await store.set("treasury", JSON.stringify({ address: "0xabc" }));
    expect(await store.get("treasury")).toEqual(JSON.stringify({ address: "0xabc" }));
  });

  it("overwrites an existing value", async () => {
    await store.set("treasury", "v1");
    await store.set("treasury", "v2");
    expect(await store.get("treasury")).toEqual("v2");
  });

  it("deletes a value", async () => {
    await store.set("treasury", "v1");
    await store.delete("treasury");
    expect(await store.get("treasury")).toBeUndefined();
  });

  it("delete is a no-op for a missing key", async () => {
    await expect(store.delete("nope")).resolves.not.toThrow();
  });

  it("lists keys that have been set", async () => {
    await store.set("treasury", "v1");
    await store.set("card", "v2");
    expect((await store.list()).sort()).toEqual(["card", "treasury"]);
  });

  it("creates the store directory lazily on first write", async () => {
    const nested = new FileStore(join(dir, "nested", "deeper"));
    await nested.set("k", "v");
    expect(await nested.get("k")).toEqual("v");
  });

  it("rejects keys that would escape the store directory", async () => {
    await expect(store.set("../escape", "v")).rejects.toThrow();
    await expect(store.set("nested/../../escape", "v")).rejects.toThrow();
    await expect(store.get("../escape")).rejects.toThrow();
  });

  it("defaults to the .data directory when no path is given", () => {
    const defaultStore = new FileStore();
    expect(defaultStore.directory).toEqual(".data");
  });
});
