import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

/**
 * A structured record of one agent/keeper/red-team action, per plan-03's global
 * constraint: every such action appends one of these. The web app's live feed reads
 * them back; nothing here assumes how.
 */
export interface AgentEvent {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Which agent (or keeper/red-team run) produced this event. */
  agent: string;
  /** Event kind, e.g. "refusal", "receipt". Free-form - callers own their own vocabulary. */
  kind: string;
  /** Structured payload; shape depends on `kind`. */
  data: Record<string, unknown>;
  /** Transaction hash, when this event corresponds to an on-chain effect. */
  txHash?: `0x${string}`;
}

/** What producers need: append one event. Kept minimal so callers (e.g. the card
 * gateway) can depend on this instead of the concrete {@link EventStore}. */
export interface EventSink {
  append(event: Omit<AgentEvent, "ts"> & { ts?: number }): Promise<void>;
}

/**
 * Durable {@link EventSink} backed by a {@link Store}: one key per event
 * (`<ts>-<uuid>`), value is the JSON-serialized {@link AgentEvent}. `list()` returns
 * every event in timestamp order for tests and any future feed/CLI to read.
 */
export class EventStore implements EventSink {
  constructor(private readonly store: Store) {}

  async append(event: Omit<AgentEvent, "ts"> & { ts?: number }): Promise<void> {
    const full: AgentEvent = { ts: event.ts ?? Date.now(), agent: event.agent, kind: event.kind, data: event.data };
    if (event.txHash !== undefined) {
      full.txHash = event.txHash;
    }
    const key = `${full.ts}-${randomUUID()}`;
    await this.store.set(key, JSON.stringify(full));
  }

  async list(): Promise<AgentEvent[]> {
    const keys = await this.store.list();
    const events: AgentEvent[] = [];
    for (const key of keys) {
      const raw = await this.store.get(key);
      if (raw !== undefined) {
        events.push(JSON.parse(raw) as AgentEvent);
      }
    }
    return events.sort((a, b) => a.ts - b.ts);
  }
}
