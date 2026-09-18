/**
 * Recursively replaces every `bigint` with its decimal-string form and drops `undefined`
 * values, so any data-layer result (a `LoanView`, an `EventsPage`, ...) becomes safe for
 * `JSON.stringify`/`NextResponse.json`. Mirrors `apps/underwriter`'s own `toJsonSafe`
 * convention exactly, so a value round-tripped through this and then through `@advance/sdk`'s
 * `reviveBigints` (used internally by the underwriter API client) comes back byte-identical.
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
