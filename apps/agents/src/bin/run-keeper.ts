#!/usr/bin/env node
/**
 * Runs the permissionless keeper against the live Base Sepolia deployment: enumerates every loan
 * on the hub, settles ended auctions, harvests loans with enough pending revenue, and marks
 * delinquent loans defaulted. Pays gas from the deployer key - keeper actions are permissionless
 * on-chain, so nothing here needs Dynamic custody.
 *
 * `--once` runs a single tick and exits (its exit code is 1 if the tick recorded any errors).
 * Without it, ticks on an interval (`KEEPER_INTERVAL_MS`, default 30000) until killed.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { createLiveKeeperActions, createLiveKeeperChainReader, tick, type KeeperTickResult } from "../keeper.js";
import { buildActionContext, loadDemoEnv, type DemoEnv } from "../demo/setup.js";

export async function runOnce(env: DemoEnv): Promise<KeeperTickResult> {
  const ctx = buildActionContext(env);
  const reader = createLiveKeeperChainReader({
    publicClient: env.publicClient,
    hub: env.hub,
    usdc: env.usdc,
    weth: env.weth,
  });
  const actions = createLiveKeeperActions(ctx, "deployer");
  const result = await tick({ reader, actions, events: env.events, agent: "keeper" });
  console.log(
    `keeper tick: checked=${result.checked} actions=${result.actionsTaken.length} errors=${result.errors.length}`,
  );
  for (const a of result.actionsTaken) {
    console.log(`  loan ${a.loanId} -> ${a.action} (${a.hash})`);
  }
  for (const e of result.errors) {
    console.log(`  error loan=${e.loanId ?? "-"} ${e.message}`);
  }
  return result;
}

function parseCliArgs(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { once: { type: "boolean", default: false } } });
  return { once: values.once ?? false };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

if (isDirectRun()) {
  const { once } = parseCliArgs(process.argv.slice(2));
  const intervalMs = Number(process.env["KEEPER_INTERVAL_MS"] ?? 30_000);

  (async () => {
    const env = await loadDemoEnv();
    if (once) {
      const result = await runOnce(env);
      process.exitCode = result.errors.length > 0 ? 1 : 0;
      return;
    }
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    process.on("SIGTERM", () => (stop = true));
    while (!stop) {
      await runOnce(env).catch((err) => console.error(err instanceof Error ? err.message : err));
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
