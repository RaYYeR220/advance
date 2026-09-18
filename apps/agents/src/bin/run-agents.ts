#!/usr/bin/env node
/**
 * Runs one tick of every provisioned agent's autonomous loop (see `brain/loop.ts`) against the
 * live Base Sepolia deployment: observe card balance/credit runway, let the deterministic code
 * policy borrow/draw if needed, then do the agent's actual work by calling its paid LLM/data
 * endpoints through the card gateway. Every payment is a real x402 settlement; every borrow/draw
 * is a real transaction signed by the agent's real Dynamic MPC keys.
 *
 * `--once` (optionally `--agent <name>` to scope to one) runs a single tick per agent and exits.
 * Without it, ticks every agent on an interval (`AGENTS_INTERVAL_MS`, default 60000) until killed.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { erc20Abi, type Address } from "viem";
import { advanceHubAbi, creditLineAbi, createLlmClient, type TermSheet } from "@advance/core";
import { createCardFetch, moveBeneficiary as moveBeneficiaryAction, openLoan as openLoanAction, drawCredit as drawCreditAction, predictEscrow as predictEscrowAction } from "@advance/agent-kit";
import { tick, type LoopActions, type LoopChainReader, type LoopDeps, type TickResult } from "../brain/loop.js";
import type { AgentRosterEntry } from "../roster.js";
import { buildActionContext, loadDemoEnv, type DemoEnv } from "../demo/setup.js";
import { listRosterNames, loadRosterEntry } from "./provision-agent.js";

function liveChainReader(env: DemoEnv): LoopChainReader {
  return {
    async cardUsdcBalance(card: Address) {
      return env.publicClient.readContract({ address: env.usdc, abi: erc20Abi, functionName: "balanceOf", args: [card] });
    },
    async activeLoan(card: Address) {
      const loanId = (await env.publicClient.readContract({
        address: env.hub,
        abi: advanceHubAbi,
        functionName: "liveLoanOf",
        args: [card],
      })) as bigint;
      if (loanId === 0n) return undefined;
      const loan = (await env.publicClient.readContract({
        address: env.hub,
        abi: advanceHubAbi,
        functionName: "loan",
        args: [loanId],
      })) as { creditLine: Address };
      return { loanId, creditLine: loan.creditLine };
    },
    async creditLineAvailable(creditLine: Address) {
      return env.publicClient.readContract({ address: creditLine, abi: creditLineAbi, functionName: "availableThisPeriod" });
    },
  };
}

function liveLoopActions(env: DemoEnv, agent: AgentRosterEntry): LoopActions {
  const ctx = buildActionContext(env);
  return {
    async predictEscrow(termSheet: TermSheet) {
      return predictEscrowAction(ctx, { termSheet });
    },
    async moveBeneficiary({ to }) {
      await moveBeneficiaryAction(ctx, { label: agent.treasuryLabel, feesManager: agent.feesManager, poolId: agent.poolId, to });
    },
    async openLoan({ termSheet, signature }) {
      const { loanId } = await openLoanAction(ctx, { label: agent.treasuryLabel, termSheet, signature });
      return { loanId };
    },
    async drawCredit({ creditLine, amount }) {
      await drawCreditAction(ctx, { ownerLabel: agent.ownerLabel, card: agent.card, creditLine, amount });
    },
  };
}

/** Runs one tick for one already-provisioned agent. */
export async function tickAgent(env: DemoEnv, agent: AgentRosterEntry): Promise<TickResult> {
  const cardFetch = createCardFetch({
    // `agent` doubles as the event-log label and the owner key's signing label (see
    // `createCardFetch`'s own doc comment) - it must resolve through `keys`, so this is the
    // card-owner label, not the agent's display name.
    agent: agent.ownerLabel,
    card: agent.card,
    keys: env.dynamicKeys,
    events: env.events,
    chain: env.publicClient,
  });
  const llm = createLlmClient({ baseUrl: agent.llm.url, model: agent.llm.model, fetchImpl: cardFetch });
  const pastEvents = await env.events.list();

  const deps: LoopDeps = {
    chain: liveChainReader(env),
    actions: liveLoopActions(env, agent),
    events: env.events,
    pastEvents,
    underwriterFetch: fetch,
    llm,
    dataFetch: cardFetch,
  };

  const result = await tick(agent, deps);
  console.log(
    `${agent.name}: runway=${result.runwayDecision.action} borrowed=${result.borrowed?.loanId ?? "-"} drew=${result.drew?.amount ?? "-"} work=${result.work.status}`,
  );
  return result;
}

function parseCliArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { once: { type: "boolean", default: false }, agent: { type: "string" } },
  });
  return { once: values.once ?? false, agent: values.agent };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

async function tickAllOnce(env: DemoEnv, only?: string): Promise<void> {
  const names = only ? [only] : await listRosterNames(env);
  for (const name of names) {
    const agent = await loadRosterEntry(env, name);
    if (!agent) {
      console.error(`no roster entry for "${name}", skipping`);
      continue;
    }
    await tickAgent(env, agent).catch((err) => console.error(`${name}: tick failed: ${err instanceof Error ? err.message : err}`));
  }
}

if (isDirectRun()) {
  const { once, agent } = parseCliArgs(process.argv.slice(2));
  const intervalMs = Number(process.env["AGENTS_INTERVAL_MS"] ?? 60_000);

  (async () => {
    const env = await loadDemoEnv();
    if (once) {
      await tickAllOnce(env, agent);
      return;
    }
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    process.on("SIGTERM", () => (stop = true));
    while (!stop) {
      await tickAllOnce(env, agent);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
