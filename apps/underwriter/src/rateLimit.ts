import type { Context, MiddlewareHandler } from "hono";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 30;

export interface RateLimitOptions {
  /** Requests allowed per window, per key. Default 30. */
  max?: number;
  /** Window size in ms. Default 60_000 (one minute). */
  windowMs?: number;
  /** Injectable clock (ms), for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** How to derive the bucket key from a request. Defaults to the first
   * `X-Forwarded-For` address (the service always runs behind a proxy/load balancer that
   * sets it), falling back to a single shared "unknown" bucket when absent. */
  keyFor?: (c: Context) => string;
}

function defaultKeyFor(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  const first = forwardedFor?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

/** Fixed-window rate limiter, in-memory per process — fine for a single-instance service;
 * a multi-instance deployment would need a shared store, out of scope here. 30 requests per
 * minute per IP by default, applied to the public `/v1/*` routes. */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const max = options.max ?? DEFAULT_MAX_REQUESTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const keyFor = options.keyFor ?? defaultKeyFor;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const key = keyFor(c);
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      c.header("retry-after", Math.ceil((bucket.resetAt - t) / 1000).toString());
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    await next();
  };
}
