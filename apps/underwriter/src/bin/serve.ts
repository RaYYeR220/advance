#!/usr/bin/env node
/**
 * HTTP bootstrap for the underwriter service: parses env config, builds the Hono app via
 * `createApp`, and serves it over real HTTP with `@hono/node-server`, with graceful
 * shutdown on SIGINT/SIGTERM (same pattern as `apps/agents`'s `serve-x402-llm.ts`).
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig, type UnderwriterConfig } from "../config.js";
import { createApp, type CreateAppOptions } from "../server.js";

const DEFAULT_PORT = 8787;

export interface StartServerOptions extends CreateAppOptions {
  port?: number;
  hostname?: string;
}

export interface RunningServer {
  server: ServerType;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the underwriter service over real HTTP and resolves once it is listening. Used
 * both by the CLI entrypoint below and by tests (with `port: 0` for an OS-assigned
 * ephemeral port).
 */
export function startServer(config: UnderwriterConfig, options: StartServerOptions = {}): Promise<RunningServer> {
  const app = createApp(config, options);
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
  const port = config.PORT ?? DEFAULT_PORT;
  startServer(config, { port }).then(
    (running) => {
      console.log(`underwriter service listening on :${running.port} (chain ${config.CHAIN_ID}, network ${config.NETWORK})`);
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
