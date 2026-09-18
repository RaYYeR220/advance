import type { Hono } from "hono";
import type { Address } from "viem";
import { InvalidUnderwriteInput, ZERO_ADDRESS, score, type ScoreDeps, type SupportedChainId } from "@advance/core";
import { toJsonSafe } from "../jsonSafe.js";
import type { EvidenceStore } from "../store.js";
import { sweepAndCap } from "../ttlMap.js";

const TOKEN_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SCORE_CACHE_TTL_MS = 5 * 60 * 1000;
/** Hard cap on distinct cached tokens. Each entry is a small JSON decision body (roughly
 * 1-2KB); 5,000 entries is a few MB regardless of how many distinct (real or fabricated)
 * token addresses get probed against this free endpoint. */
const SCORE_CACHE_MAX_ENTRIES = 5_000;

/** No agent context applies to a free score — `score()` never reads `agentCard`/`agentId`
 * for anything but address-shape validation, so the zero address is used as a placeholder
 * rather than asking the caller for agent identity it doesn't need to spend. */
const SCORE_PLACEHOLDER_AGENT_CARD: Address = ZERO_ADDRESS;

export interface ScoreRouteOptions {
  deps: ScoreDeps;
  chainId: SupportedChainId;
  hub: Address;
  evidenceStore: EvidenceStore;
  /** Unix seconds; must be within 300s of the chain's own latest block time. Defaults to
   * the real wall clock; tests inject a fixed value matching their fixture's block time. */
  now?: () => number;
  /** Injectable clock (ms) for the response cache's TTL bookkeeping. Defaults to `Date.now`. */
  cacheNow?: () => number;
  /** Hard cap on distinct cached tokens. Defaults to `SCORE_CACHE_MAX_ENTRIES` (5,000);
   * overridable for tests that want to exercise cap eviction without 5,000 fixtures. */
  cacheMaxEntries?: number;
}

interface CacheEntry {
  expiresAt: number;
  status: 200;
  body: unknown;
}

/**
 * `GET /v1/score/:token`: the free path — runs the engine up to terms + hard rules only
 * (no memo request, no signature), so it costs neither an LLM call nor a signed term
 * sheet. Cached 5 minutes per token (address-cased-insensitively) to keep repeated
 * lookups cheap and to bound how often a single token can drive real RPC/Bankr calls.
 */
export function registerScoreRoute(app: Hono, options: ScoreRouteOptions): void {
  const nowSeconds = options.now ?? (() => Math.floor(Date.now() / 1000));
  const cacheNow = options.cacheNow ?? (() => Date.now());
  const cacheMaxEntries = options.cacheMaxEntries ?? SCORE_CACHE_MAX_ENTRIES;
  const cache = new Map<string, CacheEntry>();

  app.get("/v1/score/:token", async (c) => {
    const token = c.req.param("token");
    if (!TOKEN_ADDRESS_PATTERN.test(token)) {
      return c.json({ error: "invalid token address" }, 400);
    }

    const cacheKey = token.toLowerCase();
    const t = cacheNow();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > t) {
      return c.json(cached.body as Record<string, unknown>, cached.status);
    }

    try {
      const result = await score(
        {
          token: token as Address,
          agentCard: SCORE_PLACEHOLDER_AGENT_CARD,
          agentId: 0n,
          chainId: options.chainId,
          hub: options.hub,
          now: nowSeconds(),
        },
        options.deps,
      );

      options.evidenceStore.save(result.evidenceHash, result.evidence);
      const body = toJsonSafe(result);
      // Delete-then-set (rather than overwriting a stale entry in place) so this key moves
      // to the end of the Map's iteration order — `sweepAndCap` relies on that order
      // tracking recency to evict the actually-oldest entry first. Sweep *after* the set,
      // not before: the cap must account for the entry just added, or a set that pushes the
      // count one over the limit would never actually trigger eviction.
      cache.delete(cacheKey);
      cache.set(cacheKey, { expiresAt: t + SCORE_CACHE_TTL_MS, status: 200, body });
      sweepAndCap(cache, t, cacheMaxEntries, (entry) => entry.expiresAt);
      return c.json(body as Record<string, unknown>, 200);
    } catch (err) {
      if (err instanceof InvalidUnderwriteInput) {
        return c.json({ error: err.message }, 422);
      }
      throw err;
    }
  });
}
