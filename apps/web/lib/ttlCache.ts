/**
 * A small in-process TTL cache for server-side reads that are safe to share across every
 * visitor — public chain state and underwriter API responses, never a signed-in lender's
 * own portfolio. Each instance is independent, so a test can exercise one without any
 * cross-talk with another test or with the process-wide default caches in `data.ts`/
 * `events.ts`.
 */
export interface TtlCache {
  /** Returns the cached value for `key` if it hasn't expired yet; otherwise calls `load`,
   * caches the result for `ttlMs`, and returns it. Concurrent calls for the same cold key
   * each start their own `load` (no request coalescing) — acceptable for this app's traffic,
   * and simpler than a de-duplicating variant. */
  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  /** Evicts one key, if present. */
  delete(key: string): void;
  /** Drops every cached entry. */
  clear(): void;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** `now` is injectable so tests can control expiry deterministically instead of racing the
 * real clock. Defaults to `Date.now`. */
export function createTtlCache(now: () => number = Date.now): TtlCache {
  const store = new Map<string, Entry>();

  return {
    async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      const t = now();
      const hit = store.get(key);
      if (hit && hit.expiresAt > t) {
        return hit.value as T;
      }
      const value = await load();
      store.set(key, { value, expiresAt: t + ttlMs });
      return value;
    },
    delete(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}
