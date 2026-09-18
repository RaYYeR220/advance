import { lastActionLabel } from "./economy";
import { formatUsd } from "./format";

/**
 * Shapes the merged events feed (`/api/events`'s own JSON-safe shape — every bigint already a
 * decimal string, from `jsonSafe.ts`'s `toJsonSafe`) into the economy page's live ticker rows.
 * The server's first paint and the client's periodic poll both go through this one function on
 * this one shape, so there is exactly one code path to keep correct.
 */

/** A merged event after `toJsonSafe`: every bigint field is a decimal string. Loosely typed on
 * purpose — the ticker only ever reads a handful of fields and must never throw on an event
 * shape it doesn't specifically know about. */
export interface JsonEventLike {
  source: "chain" | "agent";
  type: string;
  timestamp: number;
  loanId?: string;
  transactionHash?: string;
  logIndex?: number;
  id?: string;
  [key: string]: unknown;
}

export interface TickerEntry {
  id: string;
  timestamp: number;
  label: string;
  /** A short USD amount, when the event carries one worth showing (a sweep, a draw, a
   * repayment, a claim) — `undefined` for events with no single headline amount. */
  detail?: string;
  loanId?: string;
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The one USD amount worth putting beside an event's label, from whichever field it's
 * actually named on that event type — `usdcOut` (a harvest), `amount` (a draw, distribution,
 * claim or off-chain receipt). All of these are micro-USD/USDC-wei (1e6 == $1). */
function amountDetail(event: JsonEventLike): string | undefined {
  const raw = event.usdcOut ?? event.amount ?? (event.data as Record<string, unknown> | undefined)?.amount;
  const n = numeric(raw);
  return n === undefined ? undefined : formatUsd(n / 1_000_000, { cents: true });
}

function eventId(event: JsonEventLike): string {
  if (event.source === "chain" && event.transactionHash !== undefined && event.logIndex !== undefined) {
    return `${event.transactionHash}:${event.logIndex}`;
  }
  return event.id ?? `${event.type}:${event.timestamp}`;
}

export function tickerEntryFromEvent(event: JsonEventLike): TickerEntry {
  return {
    id: eventId(event),
    timestamp: event.timestamp,
    label: lastActionLabel(event.type) ?? event.type,
    detail: amountDetail(event),
    loanId: event.loanId,
  };
}

/** The first `limit` events (already newest-first, as `/api/events` returns them), shaped into
 * ticker rows. */
export function tickerEntriesFromEvents(events: readonly JsonEventLike[], limit = 12): TickerEntry[] {
  return events.slice(0, limit).map(tickerEntryFromEvent);
}
