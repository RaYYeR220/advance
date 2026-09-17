/**
 * Recursively replaces every `bigint` with its decimal-string form and drops `undefined`
 * values, so any engine result (`ScoreResult`, `Decision`, `EvidenceBundle`, ...) becomes
 * safe for `JSON.stringify`/`c.json`. Mirrors `@advance/core`'s own (unexported)
 * `toCanonicalSafe` bigint-to-string convention exactly, so a value round-tripped through
 * this helper and then through `evidenceHash` (which applies the same conversion) hashes
 * identically to the original bigint-typed value — see `store.ts`.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[key] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}
