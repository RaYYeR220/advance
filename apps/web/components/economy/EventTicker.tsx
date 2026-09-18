"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatClock } from "@/lib/format";
import { tickerEntriesFromEvents, type JsonEventLike, type TickerEntry } from "@/lib/ticker";
import styles from "./EconomyIndex.module.css";

export interface EventTickerProps {
  /** The server's own first read of `/api/events`, already JSON-safe — renders immediately, no
   * empty flash while the first poll is in flight. */
  initialEvents: readonly JsonEventLike[];
}

const POLL_MS = 15_000;
const SHOWN = 12;

/** Polls `/api/events` for a live feed of hub activity and off-chain agent events — on-chain
 * loan lifecycle plus refusals and receipts, newest first. Keeps showing the last good list on
 * a failed poll rather than clearing it, and respects `prefers-reduced-motion` by not
 * animating new rows in (the list itself still updates; nothing slides or fades). */
export function EventTicker({ initialEvents }: EventTickerProps) {
  const [entries, setEntries] = useState<TickerEntry[]>(() => tickerEntriesFromEvents(initialEvents, SHOWN));
  const cancelled = useRef(false);
  const lastAnnouncedId = useRef<string | undefined>(entries[0]?.id);
  // Only the single newest entry is ever announced to assistive tech — an `aria-live` region
  // on the whole visible list would re-read all 12 rows on every poll, whether or not anything
  // actually changed, interrupting a screen-reader user every 15 seconds indefinitely.
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    cancelled.current = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/events?limit=${SHOWN}`);
        if (!res.ok || cancelled.current) return;
        const page = (await res.json()) as { events?: JsonEventLike[] };
        if (cancelled.current || !Array.isArray(page.events)) return;
        const next = tickerEntriesFromEvents(page.events, SHOWN);
        setEntries(next);
        const newest = next[0];
        if (newest && newest.id !== lastAnnouncedId.current) {
          lastAnnouncedId.current = newest.id;
          setAnnouncement(`${newest.label}${newest.detail ? `, ${newest.detail}` : ""}`);
        }
      } catch {
        // Transient network hiccup — keep showing the last good list.
      }
    };
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled.current = true;
      clearInterval(timer);
    };
  }, []);

  if (entries.length === 0) {
    return <p className={styles.empty}>No activity recorded yet. The first draw, sweep or refusal prints right here.</p>;
  }

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ul className={styles.ticker}>
        {entries.map((entry) => (
          <li key={entry.id} className={styles.tickerRow}>
            <span className={styles.tickerTime}>{formatClock(entry.timestamp)}</span>
            <span className={styles.tickerLabel}>{entry.label}</span>
            {entry.detail ? <span className={styles.tickerDetail}>{entry.detail}</span> : null}
            {entry.loanId ? (
              <Link className={styles.tickerLoan} href={`/loans/${entry.loanId}`}>
                loan #{entry.loanId}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
