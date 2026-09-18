import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildAdvanceServer, type AdvanceMcpDeps } from "./server.js";

/**
 * Streamable HTTP transport on `/mcp`, stateless: a fresh `McpServer` + transport per request
 * (`sessionIdGenerator: undefined`), so concurrent clients never share request-id bookkeeping and
 * there's no session store to leak between them. `buildAdvanceServer` is cheap (it only closes
 * over `deps` and registers tool functions), so paying that cost per request is fine at this
 * scale. A plain `GET /healthz` is included for process-manager liveness checks.
 */
export function createHttpServer(deps: AdvanceMcpDeps): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
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
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });
}
