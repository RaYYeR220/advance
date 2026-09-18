import { NextResponse } from "next/server";
import { loadWebEnv } from "@/lib/env";
import { createLiveEventsSource, type EventsQuery, type EventsSource } from "@/lib/events";
import { toJsonSafe } from "@/lib/jsonSafe";
import { createTtlCache } from "@/lib/ttlCache";

/** `GET /api/events` — the merged (on-chain + off-chain), paginated event feed. Query params:
 * `loanId` (decimal), `types` (comma-separated), `sinceSeconds` (unix seconds), `limit`
 * (default/typical page size, capped at `MAX_LIMIT`), `cursor` (opaque, from a previous
 * response's `nextCursor`). No params returns the hub's recent loan lifecycle events plus any
 * configured off-chain feed — see `events.ts`'s module doc for why an unscoped query can't
 * include per-loan contract events (`Drawn`/`Harvested`/`Distributed`/`Claimed`/card
 * transfers), only `loanId`-scoped ones can. */

const MAX_LIMIT = 200;
/** Short TTL: this is public, non-per-user data, so a brief shared cache keeps a burst of
 * page loads from re-reading the chain/feed on every request without staling the feed for
 * more than a few seconds. */
const EVENTS_CACHE_TTL_MS = 5_000;

const cache = createTtlCache();

let liveEventsSource: EventsSource | undefined;
function resolveEventsSource(): EventsSource {
  liveEventsSource ??= createLiveEventsSource(loadWebEnv());
  return liveEventsSource;
}

export type ParsedEventsQuery = { query: EventsQuery } | { error: string };

/** Parses and validates the route's query string into an `EventsQuery` — pure, so it's
 * exercised directly in tests without going through a `Request`/`NextResponse` roundtrip. */
export function parseEventsQuery(searchParams: URLSearchParams): ParsedEventsQuery {
  const loanIdRaw = searchParams.get("loanId");
  let loanId: bigint | undefined;
  if (loanIdRaw !== null) {
    if (!/^\d+$/.test(loanIdRaw)) return { error: "loanId must be a non-negative integer" };
    loanId = BigInt(loanIdRaw);
  }

  const typesRaw = searchParams.get("types");
  const types = typesRaw
    ? typesRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : undefined;
  if (types && types.length === 0) return { error: "types must not be empty when provided" };

  const sinceRaw = searchParams.get("sinceSeconds");
  let sinceSeconds: number | undefined;
  if (sinceRaw !== null) {
    const n = Number(sinceRaw);
    if (!Number.isFinite(n)) return { error: "sinceSeconds must be a number" };
    sinceSeconds = n;
  }

  const limitRaw = searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) return { error: "limit must be a positive integer" };
    limit = Math.min(n, MAX_LIMIT);
  }

  const cursor = searchParams.get("cursor") ?? undefined;

  return { query: { loanId, types, sinceSeconds, limit, cursor } };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseEventsQuery(url.searchParams);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const page = await cache.get(url.search, EVENTS_CACHE_TTL_MS, () => resolveEventsSource().list(parsed.query));
    return NextResponse.json(toJsonSafe(page));
  } catch (err) {
    if (err instanceof Error && /malformed cursor/.test(err.message)) {
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    }
    throw err;
  }
}
