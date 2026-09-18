#!/usr/bin/env node
/**
 * HTTP bootstrap for the testnet x402 LLM proxy service: parses env config,
 * builds the Hono app via `createServiceApp`, and serves it over real HTTP
 * with `@hono/node-server`, with graceful shutdown on SIGINT/SIGTERM.
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { createServiceApp, type CreateServiceAppOptions } from "../services/x402-llm.js";

export interface StartServerOptions extends CreateServiceAppOptions {
  port?: number;
  hostname?: string;
}

export interface RunningServer {
  server: ServerType;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the x402-llm service over real HTTP and resolves once it is
 * listening. Used both by the CLI entrypoint below and by tests (with
 * `port: 0` for an OS-assigned ephemeral port).
 */
export function startServer(
  config: ReturnType<typeof loadConfig>,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const app = createServiceApp(config, options);
  return new Promise((resolvePromise) => {
    const server = serve(
      { fetch: app.fetch, port: options.port ?? 0, hostname: options.hostname },
      (info: AddressInfo) => {
        resolvePromise({
          server,
          port: info.port,
          close: () =>
            new Promise<void>((res, rej) => {
              server.close((err) => (err ? rej(err) : res()));
            }),
        });
      },
    );
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

if (isDirectRun()) {
  const config = loadConfig();
  const port = Number(process.env.PORT ?? 8402);
  startServer(config, { port }).then(
    (running) => {
      console.log(`x402-llm service listening on :${running.port} (chain ${config.CHAIN_ID})`);
      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`received ${signal}, shutting down`);
        running
          .close()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
          });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
