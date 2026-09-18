import { createApp } from "@advance/underwriter";
import { loadConfig } from "@advance/underwriter/config";

// The underwriter engine signs term sheets, reads `EVIDENCE_DIR` off disk, and calls out to
// an RPC/LLM — none of that belongs on the Edge runtime.
export const runtime = "nodejs";
// Always a live backend call (chain reads, payments, signed evidence) — never statically
// optimized or cached by Next.
export const dynamic = "force-dynamic";

/**
 * Mounts the underwriter's Hono API (`/health`, `/v1/score/:token`, `POST /v1/quote`,
 * `/v1/evidence/:hash`) on this same Next.js deployment under `/api/*`, so the site and the
 * API share one origin — one URL for judges, and a stable host for x402's `payTo`/resource
 * URL. Built once per serverless instance (module scope) and reused across warm
 * invocations, which is also why the evidence store and rate limiter below are
 * per-instance on Vercel rather than global (see `EVIDENCE_DIR`, set to `/tmp`).
 */
const app = createApp(loadConfig());

/**
 * The underwriter app's routes (and its x402 payment gate, which matches the literal string
 * `"POST /v1/quote"` — see `apps/underwriter/src/payment.ts`) are registered with no `/api`
 * prefix. Hono's own `.route()` composition would leave `/api` in `c.req.path` and silently
 * break that match, so instead this rewrites the incoming request's URL to drop the leading
 * `/api` before handing it to `app.fetch`, keeping every route (including the payment gate)
 * byte-for-byte the same as the standalone service.
 */
async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/^\/api/, "") || "/";
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req.body : undefined,
  };
  if (hasBody) init.duplex = "half";
  return app.fetch(new Request(url, init));
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
export const HEAD = proxy;
