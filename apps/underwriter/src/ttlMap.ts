/**
 * Bounds an in-memory `Map`'s growth: drops anything already expired, then — if the map
 * is still over `maxEntries` — evicts the oldest surviving entries (`Map` iteration order
 * is insertion order) until it's back at or under the cap. Shared by every in-memory
 * cache in this service (`rateLimit.ts`'s buckets, `routes/score.ts`'s response cache) so
 * a flood of distinct keys — spoofed or real — can never grow memory unboundedly: the
 * cap is a hard backstop regardless of whether TTL expiry alone keeps up.
 *
 * O(n) in the current entry count, which is itself capped at `maxEntries`, so this is
 * bounded work per call, never unbounded. Callers only run it when a *new* key is about
 * to be added (not on every read/hit), so its frequency tracks the rate of distinct keys,
 * not total traffic.
 */
export function sweepAndCap<V>(map: Map<string, V>, now: number, maxEntries: number, expiresAtOf: (value: V) => number): void {
  for (const [key, value] of map) {
    if (expiresAtOf(value) <= now) map.delete(key);
  }
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}
