import { describe, expect, it, vi } from "vitest";
import { createTtlCache } from "@/lib/ttlCache";

describe("createTtlCache", () => {
  it("calls load once and reuses the value while fresh", async () => {
    let now = 1_000;
    const cache = createTtlCache(() => now);
    const load = vi.fn(async () => "value-a");

    expect(await cache.get("key", 10_000, load)).toBe("value-a");
    now += 5_000;
    expect(await cache.get("key", 10_000, load)).toBe("value-a");

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the entry expires", async () => {
    let now = 1_000;
    const cache = createTtlCache(() => now);
    const load = vi.fn(async () => `value-at-${now}`);

    expect(await cache.get("key", 1_000, load)).toBe("value-at-1000");
    now += 1_001;
    expect(await cache.get("key", 1_000, load)).toBe("value-at-2001");

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("expiry is exclusive at the boundary (expiresAt itself counts as stale)", async () => {
    let now = 0;
    const cache = createTtlCache(() => now);
    const load = vi.fn(async () => now);

    await cache.get("key", 100, load);
    now = 100;
    await cache.get("key", 100, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps independent keys independent", async () => {
    const cache = createTtlCache(() => 0);
    const loadA = vi.fn(async () => "a");
    const loadB = vi.fn(async () => "b");

    expect(await cache.get("a", 10_000, loadA)).toBe("a");
    expect(await cache.get("b", 10_000, loadB)).toBe("b");
    expect(await cache.get("a", 10_000, loadA)).toBe("a");

    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it("delete evicts a single key without touching others", async () => {
    const cache = createTtlCache(() => 0);
    const load = vi.fn(async () => "value");

    await cache.get("key", 10_000, load);
    cache.delete("key");
    await cache.get("key", 10_000, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clear evicts every key", async () => {
    const cache = createTtlCache(() => 0);
    const load = vi.fn(async () => "value");

    await cache.get("a", 10_000, load);
    await cache.get("b", 10_000, load);
    cache.clear();
    await cache.get("a", 10_000, load);

    expect(load).toHaveBeenCalledTimes(3);
  });

  it("two isolated cache instances never share entries", async () => {
    const cacheA = createTtlCache(() => 0);
    const cacheB = createTtlCache(() => 0);
    await cacheA.get("key", 10_000, async () => "from-a");

    const loadB = vi.fn(async () => "from-b");
    expect(await cacheB.get("key", 10_000, loadB)).toBe("from-b");
    expect(loadB).toHaveBeenCalledTimes(1);
  });
});
