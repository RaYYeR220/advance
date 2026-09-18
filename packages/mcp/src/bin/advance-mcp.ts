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
import { createHttpServer } from "../http.js";
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

if (isDirectRun()) {
  const config = loadConfig();
  const deps = buildDeps(config);

  if (process.argv.includes("--http")) {
    const port = config.port ?? DEFAULT_HTTP_PORT;
    const server = createHttpServer(deps);
    server.listen(port, () => {
      // stdout is reserved for JSON-RPC in stdio mode; this branch never uses stdio, but stderr
      // is the safe habit regardless.
      console.error(`advance-mcp listening on :${port}/mcp (chain ${config.chainId})`);
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
