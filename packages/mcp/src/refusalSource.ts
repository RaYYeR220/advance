import { z } from "zod";

/**
 * The event shape the runtime writes for every credit-policy decision it makes on an agent's
 * behalf: `"refusal"` (the policy itself said no — a layer, a reason, and, for a payment refusal,
 * the `payTo`/`amount` it refused), `"receipt"` (a successful payment or draw — never returned by
 * `RefusalSource`), and `"settlement_failed"` (the policy approved but the chain call itself
 * failed). Defined here rather than imported from the agent runtime package so this server has no
 * dependency on it — any runtime that writes this shape to a feed `RefusalSource` can read works.
 */
export interface RefusalEvent {
  ts: number;
  agent: string;
  kind: "refusal" | "receipt" | "settlement_failed";
  data: {
    layer: string;
    reason: string;
    payTo?: string;
    amount?: string;
  };
  txHash?: string;
}

const RefusalEventSchema = z.object({
  ts: z.union([z.number(), z.string()]).transform((v) => (typeof v === "string" ? Number(v) : v)),
  agent: z.string(),
  kind: z.enum(["refusal", "receipt", "settlement_failed"]),
  data: z.object({
    layer: z.string(),
    reason: z.string(),
    payTo: z.string().optional(),
    amount: z.string().optional(),
  }),
  txHash: z.string().optional(),
});

/** Thrown for any reason `RefusalSource.latestForAgent` couldn't get a real answer — feed not
 * configured, unreachable, or not shaped like the event feed. The tool that calls it turns this
 * into a structured "unavailable" result rather than a fabricated "no refusals found". */
export class RefusalSourceUnavailable extends Error {}

/** Reads the latest refusal-relevant events (`"refusal"` and `"settlement_failed"` — `"receipt"`
 * events are successes and never belong in a refusal explanation) for one agent. Minimal and
 * injectable on purpose: the default implementation below fetches a static JSON feed URL from
 * env, but an agent runtime with its own event store passes a different implementation of this
 * same interface into `buildAdvanceServer` instead. */
export interface RefusalSource {
  latestForAgent(agent: string, limit: number): Promise<RefusalEvent[]>;
}

function parseEvents(body: unknown): RefusalEvent[] {
  const raw = Array.isArray(body) ? body : isEventsWrapper(body) ? body.events : undefined;
  if (raw === undefined) {
    throw new RefusalSourceUnavailable(
      "refusal events feed body must be a JSON array of events or { events: [...] }",
    );
  }
  const events: RefusalEvent[] = [];
  for (const entry of raw) {
    const parsed = RefusalEventSchema.safeParse(entry);
    // A malformed individual entry is dropped, not fatal — one bad row in the feed shouldn't
    // hide every other agent's genuine refusal history.
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

function isEventsWrapper(body: unknown): body is { events: unknown[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    "events" in body &&
    Array.isArray((body as { events: unknown }).events)
  );
}

/**
 * Default `RefusalSource`: `GET`s `ADVANCE_EVENTS_URL` and filters the result down to `agent`'s
 * `"refusal"`/`"settlement_failed"` events, newest first. Fails closed — an unconfigured URL, a
 * failed request, or a body that isn't the expected shape throws `RefusalSourceUnavailable`
 * rather than silently reporting "no refusals" (which would read as "this agent is healthy").
 */
export function httpJsonRefusalSource(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): RefusalSource {
  return {
    async latestForAgent(agent, limit) {
      const url = env.ADVANCE_EVENTS_URL;
      if (!url) {
        throw new RefusalSourceUnavailable(
          "ADVANCE_EVENTS_URL is not configured — this server has no refusal-events feed to read",
        );
      }

      let res: Response;
      try {
        res = await fetchImpl(url);
      } catch (err) {
        throw new RefusalSourceUnavailable(
          `refusal events feed request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        throw new RefusalSourceUnavailable(`refusal events feed returned status ${res.status}`);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new RefusalSourceUnavailable("refusal events feed did not return valid JSON");
      }

      const normalizedAgent = agent.toLowerCase();
      return parseEvents(body)
        .filter((e) => e.agent.toLowerCase() === normalizedAgent && e.kind !== "receipt")
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
    },
  };
}
