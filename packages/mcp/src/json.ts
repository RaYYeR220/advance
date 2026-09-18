/**
 * Recursively replaces every `bigint` with its decimal-string form and drops `undefined`
 * values, mirroring `apps/underwriter`'s `toJsonSafe` convention exactly: a tool result and the
 * underwriter API response it may itself contain (e.g. a `Decision` inside `advance_get_quote`'s
 * output) render bigints the same way everywhere an agent sees this protocol.
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

/** Matches a plain decimal integer string — the wire form `toJsonSafe` turns a `bigint` into.
 * Used to revive a `decision` object an agent copies verbatim from `advance_get_quote`'s output
 * back into `advance_apply`'s input, without a hand-maintained list of which fields are bigints. */
const DECIMAL_STRING_PATTERN = /^-?\d+$/;

export function reviveBigints(value: unknown): unknown {
  if (typeof value === "string" && DECIMAL_STRING_PATTERN.test(value)) {
    return BigInt(value);
  }
  if (Array.isArray(value)) {
    return value.map(reviveBigints);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = reviveBigints(v);
    }
    return out;
  }
  return value;
}

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
