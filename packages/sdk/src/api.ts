import type { Address, Hex } from "viem";
import type { Decision, EvidenceBundle, ScoreResult, SupportedChainId } from "@advance/core";

/** Thrown for any non-2xx response from the underwriter API. `status` is the HTTP status;
 * `message` is the response body's `error` field when present, otherwise a generic summary. */
export class AdvanceApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdvanceApiError";
    this.status = status;
  }
}

export interface ApiClientOptions {
  /** Base URL of the underwriter API (no trailing slash), e.g. `https://underwriter.example.com`. */
  apiUrl: string;
  /** Used for the free `score`/`evidence` reads. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Used for the paid `quote` call (x402-aware). Falls back to `fetchImpl`/`fetch` when omitted —
   * `quote` still works against an underwriter that isn't charging yet. */
  paymentFetch?: typeof fetch;
}

export interface QuoteRequest {
  token: Address;
  agentCard: Address;
  agentId: bigint;
  chainId: SupportedChainId;
}

function isErrorBody(body: unknown): body is { error: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  );
}

/** Matches a plain decimal integer string — exactly what `apps/underwriter`'s `toJsonSafe` (and
 * `@advance/core`'s own `toCanonicalSafe`) turns a `bigint` into and nothing else: every other
 * string field in these responses is either `0x`-prefixed (an address or hash) or prose, never a
 * bare digit string. Revives the wire JSON back into the same bigint-typed shape the underwriter
 * computed, without needing a hand-maintained list of which field names are bigint. */
const DECIMAL_STRING_PATTERN = /^-?\d+$/;

function reviveBigints(value: unknown): unknown {
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

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new AdvanceApiError(
      res.status,
      isErrorBody(body) ? body.error : `request to ${url} failed with status ${res.status}`,
    );
  }
  return body;
}

/** `GET /v1/score/:token` — free eligibility check, no memo/signature spent. */
export async function fetchScore(opts: ApiClientOptions, token: Address): Promise<ScoreResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = await getJson(fetchImpl, `${opts.apiUrl}/v1/score/${token}`);
  return reviveBigints(body) as ScoreResult;
}

/** `POST /v1/quote` — the paid path: a full engine run, signed `TermSheet` on approval. Uses
 * `paymentFetch` when the caller provided one (x402-aware), otherwise plain `fetch`. */
export async function fetchQuote(opts: ApiClientOptions, req: QuoteRequest): Promise<Decision> {
  const fetchImpl = opts.paymentFetch ?? opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.apiUrl}/v1/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: req.token,
      agentCard: req.agentCard,
      agentId: req.agentId.toString(),
      chainId: req.chainId,
    }),
  });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new AdvanceApiError(
      res.status,
      isErrorBody(body) ? body.error : `quote request failed with status ${res.status}`,
    );
  }
  return reviveBigints(body) as Decision;
}

/** `GET /v1/evidence/:hash` — the canonical evidence bundle a decision's `evidenceHash` was
 * computed from. */
export async function fetchEvidence(opts: ApiClientOptions, hash: Hex): Promise<EvidenceBundle> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = await getJson(fetchImpl, `${opts.apiUrl}/v1/evidence/${hash}`);
  return reviveBigints(body) as EvidenceBundle;
}
