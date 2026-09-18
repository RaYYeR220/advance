#!/usr/bin/env node
/**
 * CLI entrypoint: stdio by default (spawn this process from an MCP client config), `--http` to
 * serve Streamable HTTP on `/mcp` instead. Config comes entirely from env (see `config.ts`) —
 * `ADVANCE_SIGNER` unset just means write tools return a structured error, everything else still
 * works, so this boots fine in a read-only deployment.
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { chainById } from "@advance/core";
import { loadConfig, type McpConfig } from "../config.js";
import { buildAdvanceOperations } from "../client.js";
import { envPrivateKeySigner } from "../signer.js";
import { httpJsonRefusalSource } from "../refusalSource.js";
import { createHttpServer, type HttpServerOptions } from "../http.js";
import { runStdioServer } from "../stdio.js";
import type { AdvanceMcpDeps } from "../server.js";

const DEFAULT_HTTP_PORT = 8788;

function buildDeps(config: McpConfig): AdvanceMcpDeps {
  return {
    advance: buildAdvanceOperations({
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      apiUrl: config.apiUrl,
      hub: config.hub,
    }),
    chainId: config.chainId,
    signer: envPrivateKeySigner(chainById(config.chainId), config.rpcUrl),
    refusalSource: httpJsonRefusalSource(),
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

/** Refuses to boot into an insecure state rather than silently serving one: an explicit
 * `MCP_BIND_HOST` (anything other than the loopback default) means this is reachable from off
 * this machine, so `MCP_AUTH_TOKEN` must be configured before it starts listening at all — never
 * logs the token itself, only whether one is present. */
function httpOptionsOrExit(config: McpConfig): HttpServerOptions {
  if (config.hostExplicit && !config.authToken) {
    console.error(
      "advance-mcp: MCP_BIND_HOST is set but MCP_AUTH_TOKEN is not — refusing to start an HTTP transport reachable from outside this machine without a token",
    );
    process.exit(1);
  }
  return {
    authRequired: config.hostExplicit,
    authToken: config.authToken,
    allowedHostnames: config.allowedOriginHostnames,
  };
}

if (isDirectRun()) {
  const config = loadConfig();
  const deps = buildDeps(config);

  if (process.argv.includes("--http")) {
    const port = config.port ?? DEFAULT_HTTP_PORT;
    const httpOptions = httpOptionsOrExit(config);
    const server = createHttpServer(deps, httpOptions);
    server.listen(port, config.host, () => {
      // stdout is reserved for JSON-RPC in stdio mode; this branch never uses stdio, but stderr
      // is the safe habit regardless.
      console.error(
        `advance-mcp listening on ${config.host}:${port}/mcp (chain ${config.chainId}, auth ${httpOptions.authRequired ? "required" : "not required (loopback default)"})`,
      );
    });
    const shutdown = (signal: string) => {
      console.error(`received ${signal}, shutting down`);
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } else {
    runStdioServer(deps).catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
  }
}
