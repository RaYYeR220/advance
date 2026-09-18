import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { sweepAndCap } from "./ttlMap.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 30;

/** Hard cap on distinct rate-limit buckets held at once. Each bucket is a tiny
 * `{count,resetAt}` record, so 10,000 of them is well under 1MB — comfortably above any
 * legitimate traffic this single-instance service expects in one window, while still
 * bounding memory against a flood of distinct keys (spoofed `X-Forwarded-For` values when
 * `TRUST_PROXY` is on, or simply many distinct real clients). */
const DEFAULT_MAX_BUCKETS = 10_000;

export interface RateLimitOptions {
  /** Requests allowed per window, per key. Default 30. */
  max?: number;
  /** Window size in ms. Default 60_000 (one minute). */
  windowMs?: number;
  /** Hard cap on distinct buckets held at once. Default 10_000 — see the constant above. */
  maxBuckets?: number;
  /** Injectable clock (ms), for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** How to derive the bucket key from a request. Defaults to {@link defaultKeyFor}`(false)`
   * — the real socket address, never a client-supplied header. */
  keyFor?: (c: Context) => string;
}

/** The real socket address of the underlying TCP connection — the one thing a client
 * cannot spoof. Requires this app to be served through `@hono/node-server`'s `serve()`
 * (which populates `c.env` with the raw Node request/socket); outside that context —
 * calling `app.request()` directly, as this service's own non-fork test suite does, or a
 * future non-Node runtime — `getConnInfo` throws, and this falls back to a single shared
 * "unknown" bucket rather than ever letting the failure crash the request. */
function socketKeyFor(c: Context): string {
  try {
    const info = getConnInfo(c);
    return info.remote.address && info.remote.address.length > 0 ? info.remote.address : "unknown";
  } catch {
    return "unknown";
  }
}

/** Trusts the first hop of `X-Forwarded-For`, falling back to the socket address when the
 * header is absent. Only ever wired in when `TRUST_PROXY` is explicitly on. */
function forwardedForKeyFor(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  const first = forwardedFor?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : socketKeyFor(c);
}

/**
 * The rate limiter's default key selector: the real socket address, unless `trustProxy`
 * is explicitly true, in which case the client-supplied `X-Forwarded-For` header is
 * trusted instead. `trustProxy` must only be true when this service always runs behind a
 * known proxy/load balancer that sets that header itself — trusting it from an untrusted
 * client lets that client mint unlimited buckets by spoofing a fresh value on every
 * request (the vulnerability this function exists to close).
 */
export function defaultKeyFor(trustProxy: boolean): (c: Context) => string {
  return trustProxy ? forwardedForKeyFor : socketKeyFor;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window rate limiter, in-memory per process — fine for a single-instance service;
 * a multi-instance deployment would need a shared store, out of scope here. 30 requests
 * per minute per key by default (real socket address unless `TRUST_PROXY=1`), applied to
 * the public `/v1/*` routes, with a hard cap of `maxBuckets` distinct keys held at once so
 * a flood of distinct keys can't grow memory unboundedly (see `ttlMap.ts`). */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const max = options.max ?? DEFAULT_MAX_REQUESTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const now = options.now ?? (() => Date.now());
  const keyFor = options.keyFor ?? defaultKeyFor(false);
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const key = keyFor(c);
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      // A fresh window: drop-then-set (rather than mutating in place) so this key moves to
      // the end of the Map's iteration order — `sweepAndCap` relies on iteration order
      // tracking recency to evict the actually-oldest bucket first.
      buckets.delete(key);
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
      sweepAndCap(buckets, t, maxBuckets, (b) => b.resetAt);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      c.header("retry-after", Math.ceil((bucket.resetAt - t) / 1000).toString());
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    await next();
  };
}
