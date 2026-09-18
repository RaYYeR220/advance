import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer, type HttpServerOptions } from "../src/http.js";
import type { AdvanceMcpDeps } from "../src/server.js";
import { createFakeAdvanceOperations } from "./fixtures.js";

function deps(): AdvanceMcpDeps {
  return {
    advance: createFakeAdvanceOperations(),
    chainId: 84532,
    signer: async () => undefined,
    refusalSource: { latestForAgent: async () => [] },
  };
}

const LOCALHOST_ONLY: HttpServerOptions = { authRequired: false, allowedHostnames: ["localhost", "127.0.0.1"] };

async function listen(options: HttpServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createHttpServer(deps(), options);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())) };
}

/** Raw `node:http` request so headers like `Host` (forbidden to set via `fetch`/undici) can be
 * forged for the DNS-rebinding tests. */
function rawRequest(
  port: number,
  opts: { path?: string; headers?: Record<string, string>; host?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: opts.path ?? "/healthz",
        method: "GET",
        headers: { ...opts.headers, ...(opts.host ? { host: opts.host } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("advance mcp http transport security", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("localhost default: an unauthenticated request with no Origin header still works", async () => {
    const listening = await listen(LOCALHOST_ONLY);
    close = listening.close;

    const res = await rawRequest(listening.port, {});
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("rejects a request on a non-local bind without a bearer token (401)", async () => {
    const listening = await listen({ authRequired: true, authToken: "secret-token", allowedHostnames: ["127.0.0.1"] });
    close = listening.close;

    const res = await rawRequest(listening.port, {});
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("accepts a request on a non-local bind with the correct bearer token", async () => {
    const listening = await listen({ authRequired: true, authToken: "secret-token", allowedHostnames: ["127.0.0.1"] });
    close = listening.close;

    const res = await rawRequest(listening.port, { headers: { authorization: "Bearer secret-token" } });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong bearer token (401), not just a missing one", async () => {
    const listening = await listen({ authRequired: true, authToken: "secret-token", allowedHostnames: ["127.0.0.1"] });
    close = listening.close;

    const res = await rawRequest(listening.port, { headers: { authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
  });

  it("rejects a mismatched Origin header (403), auth or not", async () => {
    const listening = await listen(LOCALHOST_ONLY);
    close = listening.close;

    const res = await rawRequest(listening.port, { headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden_origin" });
  });

  it("allows an Origin header that matches the allowlist", async () => {
    const listening = await listen(LOCALHOST_ONLY);
    close = listening.close;

    const res = await rawRequest(listening.port, { headers: { origin: "http://localhost:5173" } });
    expect(res.status).toBe(200);
  });

  it("rejects a mismatched Host header (403) — the actual DNS-rebinding defense", async () => {
    const listening = await listen(LOCALHOST_ONLY);
    close = listening.close;

    const res = await rawRequest(listening.port, { host: "evil.example.com" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden_host" });
  });

  it("MCP_ALLOWED_ORIGINS-style extra hostnames are honored", async () => {
    const listening = await listen({ authRequired: false, allowedHostnames: ["127.0.0.1", "myagent.example.com"] });
    close = listening.close;

    const res = await rawRequest(listening.port, { headers: { origin: "https://myagent.example.com" } });
    expect(res.status).toBe(200);
  });
});
