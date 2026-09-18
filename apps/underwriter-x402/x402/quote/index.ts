/**
 * Bankr x402 Cloud handler for the paid underwriting quote endpoint. Forwards the request
 * body straight to the underwriter API's own POST /v1/quote and returns its decision
 * unchanged. The underwriter API is itself x402-gated (see apps/underwriter/src/payment.ts)
 * — this deployment carries the payment collected by Bankr's edge through to the
 * underwriter with a shared internal key, so the request is never charged twice.
 */

interface QuoteRequestBody {
  token: string;
  agentCard: string;
  agentId: string;
  chainId: number;
}

function isQuoteRequestBody(value: unknown): value is QuoteRequestBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).token === "string" &&
    typeof (value as Record<string, unknown>).agentCard === "string" &&
    (typeof (value as Record<string, unknown>).agentId === "string" ||
      typeof (value as Record<string, unknown>).agentId === "number") &&
    typeof (value as Record<string, unknown>).chainId === "number"
  );
}

export default async function handler(req: Request): Promise<unknown> {
  const underwriterApiUrl = process.env.UNDERWRITER_API_URL;
  const internalKey = process.env.UNDERWRITER_INTERNAL_KEY;
  if (!underwriterApiUrl) {
    throw new Error("UNDERWRITER_API_URL is not configured for this deployment");
  }

  const body: unknown = await req.json();
  if (!isQuoteRequestBody(body)) {
    throw new Error("request body must include token, agentCard, agentId, chainId");
  }

  const upstream = await fetch(`${underwriterApiUrl.replace(/\/+$/, "")}/v1/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(internalKey ? { "x-internal-key": internalKey } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    throw new Error(`underwriter quote request failed (${upstream.status}): ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}
