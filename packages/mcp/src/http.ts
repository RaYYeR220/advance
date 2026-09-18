import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildAdvanceServer, type AdvanceMcpDeps } from "./server.js";

export interface HttpServerOptions {
  /** When true, every request must carry `Authorization: Bearer <authToken>` — set by the CLI
   * whenever `MCP_BIND_HOST` was explicitly configured (see `config.ts`). */
  authRequired: boolean;
  authToken?: string;
  /** Hostnames the `Origin` and `Host` headers are checked against — always includes the
   * localhost defaults (see `config.ts`'s `parseAllowedOriginHostnames`). */
  allowedHostnames: string[];
}

/** Parses a `Host` header (`hostname`, `hostname:port`, `[::1]:port`) down to its bare, lowercase
 * hostname, for comparing against an allowlist that doesn't care about the port. */
function hostnameFromHostHeader(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return (end === -1 ? trimmed : trimmed.slice(1, end)).toLowerCase();
  }
  const colon = trimmed.lastIndexOf(":");
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

function hostnameFromOrigin(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowedHost(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  return header !== undefined && allowed.has(hostnameFromHostHeader(header));
}

/** No `Origin` header at all (the common case for a non-browser MCP client — curl, another
 * server, this repo's own tests) is allowed through: `Origin` is a browser-added signal, its
 * absence isn't itself suspicious. When it *is* present, it must resolve to an allowed hostname —
 * this is what actually stops a DNS-rebound page's browser-issued fetch. */
function isAllowedOrigin(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (header === undefined) return true;
  const hostname = hostnameFromOrigin(header);
  return hostname !== undefined && allowed.has(hostname);
}

/** Constant-time bearer-token comparison — a naive `===` leaks how many leading bytes matched via
 * timing, which matters for a secret this short-lived-server-lifetime static. */
function isValidBearerToken(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const presented = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * Streamable HTTP transport on `/mcp`, stateless: a fresh `McpServer` + transport per request
 * (`sessionIdGenerator: undefined`), so concurrent clients never share request-id bookkeeping and
 * there's no session store to leak between them. `buildAdvanceServer` is cheap (it only closes
 * over `deps` and registers tool functions), so paying that cost per request is fine at this
 * scale. A plain `GET /healthz` is included for process-manager liveness checks.
 *
 * Every request — `/healthz` included — passes two checks before it's routed, regardless of
 * `authRequired`: the `Host` header must resolve to an allowed hostname, and the `Origin` header
 * (if the request has one) must too. This is the MCP spec's recommended DNS-rebinding defense for
 * a local HTTP server: without it, a malicious page a browser has open could have its own DNS
 * name resolve to `127.0.0.1` and issue same-origin-looking requests straight at this server. When
 * `authRequired` is set (the CLI does this whenever `MCP_BIND_HOST` was explicitly configured —
 * i.e. this isn't bound to loopback-only by default), a request additionally needs a valid
 * `Authorization: Bearer <token>` header; the token itself is never logged anywhere in this file.
 */
export function createHttpServer(deps: AdvanceMcpDeps, options: HttpServerOptions): Server {
  const allowedHostnames = new Set(options.allowedHostnames.map((h) => h.toLowerCase()));

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!isAllowedHost(req.headers.host, allowedHostnames)) {
      sendJson(res, 403, { error: "forbidden_host" });
      return;
    }
    const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!isAllowedOrigin(originHeader, allowedHostnames)) {
      sendJson(res, 403, { error: "forbidden_origin" });
      return;
    }
    if (options.authRequired) {
      const token = options.authToken;
      if (!token || !isValidBearerToken(req.headers.authorization, token)) {
        sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildAdvanceServer(deps);
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_server_error" });
      }
    }
  });
}
