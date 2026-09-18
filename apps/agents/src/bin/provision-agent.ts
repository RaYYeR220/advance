#!/usr/bin/env node
/**
 * Provisions one autonomous borrower agent end to end on Base Sepolia: a real Dynamic MPC
 * treasury key and card-owner key, an ERC-8004 identity registration, a real Doppler token
 * launch (fee recipient = the treasury), an on-chain `AgentCard` (owner = the card-owner key,
 * payees = this deployment's x402 service payTo addresses), a synced Dynamic tx allowlist, and
 * a persisted roster record any of the other bins can load by name.
 *
 * Idempotent: re-running with the same `--name` reuses whatever step already completed (an
 * existing Dynamic key, a card already deployed and recorded) instead of repeating it.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { getAddress, parseEther, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registerAgent, syncAllowlist } from "@advance/agent-kit";
import { runLaunchToken } from "./launch-token.js";
import { loadDemoEnv, buildActionContext, type DemoEnv } from "../demo/setup.js";
import { withDynamicSigningRetry, withNonceRetry } from "../chain/localKeys.js";
import type { AgentRosterEntry } from "../roster.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** apps/agents/src/bin -> repo root is four levels up. */
const REPO_ROOT = resolvePath(__dirname, "../../../../");

export interface ProvisionAgentParams {
  name: string;
  persona: string;
  tokenName: string;
  tokenSymbol: string;
  /** USDC-wei per x402 call this card may ever authorize. */
  perCallCap: bigint;
  /** Seconds an authorization's validBefore may extend past "now". */
  maxAuthWindow: bigint;
  /** Extra payees beyond the shared service payTo (e.g. a second address for red-team probes). */
  extraPayees?: Address[];
  llmUrl: string;
  llmModel: string;
  dataUrl: string;
  underwriterUrl: string;
  /** ETH funded to each of the treasury/owner keys if their balance is below this. */
  gasTopUpEth?: string;
}

function agentCardArtifact(): { abi: readonly unknown[]; bytecode: `0x${string}` } {
  const path = resolvePath(REPO_ROOT, "contracts/out/AgentCard.sol/AgentCard.json");
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    abi: readonly unknown[];
    bytecode: { object: `0x${string}` };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function ensureKey(env: DemoEnv, label: string): Promise<Address> {
  try {
    const { address } = await env.dynamicKeys.createKey(label);
    return address as Address;
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      return (await env.dynamicKeys.address(label)) as Address;
    }
    throw err;
  }
}

async function topUpGas(env: DemoEnv, address: Address, minEth: string): Promise<void> {
  const min = parseEther(minEth);
  const balance = await env.publicClient.getBalance({ address });
  if (balance >= min) return;
  const hash = await withNonceRetry(async () => {
    const deployerAccount = privateKeyToAccount(env.deployerPrivateKey);
    const wallet = createWalletClient({ account: deployerAccount, chain: baseSepolia, transport: http(env.rpcUrl) });
    return wallet.sendTransaction({ to: address, value: min - balance });
  });
  await env.publicClient.waitForTransactionReceipt({ hash });
  await env.events.append({ agent: "provisioner", kind: "gas_topup", data: { to: address, amount: (min - balance).toString() }, txHash: hash });
}

async function deployAgentCard(
  env: DemoEnv,
  params: { owner: Address; perCallCap: bigint; maxAuthWindow: bigint; payees: Address[] },
): Promise<Address> {
  const { abi, bytecode } = agentCardArtifact();
  const hash = await withNonceRetry(async () => {
    const deployerAccount = privateKeyToAccount(env.deployerPrivateKey);
    const wallet = createWalletClient({ account: deployerAccount, chain: baseSepolia, transport: http(env.rpcUrl) });
    return wallet.deployContract({
      abi,
      bytecode,
      args: [params.owner, env.hub, env.usdc, params.perCallCap, params.maxAuthWindow, params.payees],
    });
  });
  const receipt = await env.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`AgentCard deployment failed (tx ${hash})`);
  }
  await env.events.append({
    agent: "provisioner",
    kind: "deploy_agent_card",
    data: { owner: params.owner, perCallCap: params.perCallCap.toString(), maxAuthWindow: params.maxAuthWindow.toString(), payees: params.payees },
    txHash: hash,
  });
  return getAddress(receipt.contractAddress);
}

/**
 * Runs (or resumes) one agent's full provisioning. Returns the persisted roster entry - the same
 * shape `run-agents.ts` loads back out of the store.
 */
export async function provisionAgent(env: DemoEnv, params: ProvisionAgentParams): Promise<AgentRosterEntry> {
  const existingRaw = await env.store.get(`roster-${params.name}`);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as ReturnType<typeof rosterToJson>;
    return rosterFromJson(existing);
  }

  const treasuryLabel = `${params.name}-treasury`;
  const ownerLabel = `${params.name}-owner`;

  const treasuryAddress = await ensureKey(env, treasuryLabel);
  const ownerAddress = await ensureKey(env, ownerLabel);
  await topUpGas(env, treasuryAddress, params.gasTopUpEth ?? "0.002");
  await topUpGas(env, ownerAddress, params.gasTopUpEth ?? "0.0015");

  const ctx = buildActionContext(env);
  const agentURI = `data:application/json,${encodeURIComponent(JSON.stringify({ name: params.name, persona: params.persona }))}`;
  const { agentId } = await withDynamicSigningRetry(() => registerAgent(ctx, { label: treasuryLabel, agentURI }));

  const launch = await withNonceRetry(() =>
    runLaunchToken(
      { chain: "base-sepolia", name: params.tokenName, symbol: params.tokenSymbol, feeRecipient: treasuryAddress, execute: true },
      { sepoliaRpcUrl: env.rpcUrl, deployerPrivateKey: env.deployerPrivateKey },
    ),
  );
  if (!launch.dopplerResult?.tokenAddress || !launch.dopplerResult.poolId) {
    throw new Error(`token launch for ${params.name} did not return a token/poolId`);
  }
  const token = getAddress(launch.dopplerResult.tokenAddress);
  const poolId = launch.dopplerResult.poolId as `0x${string}`;

  const payees = [env.servicePayTo, ...(params.extraPayees ?? [])];
  const card = await deployAgentCard(env, { owner: ownerAddress, perCallCap: params.perCallCap, maxAuthWindow: params.maxAuthWindow, payees });

  await syncAllowlist({
    chainIds: [84532],
    addresses: [env.hub, card, env.feesManager, env.identityRegistry],
    name: `${params.name}-allowlist`,
  });

  const entry: AgentRosterEntry = {
    name: params.name,
    persona: params.persona,
    chainId: 84532,
    token,
    poolId,
    feesManager: env.feesManager,
    agentId,
    treasuryLabel,
    ownerLabel,
    card,
    llm: { url: params.llmUrl, model: params.llmModel, dataUrl: params.dataUrl },
    underwriterUrl: params.underwriterUrl,
  };
  await env.store.set(`roster-${params.name}`, JSON.stringify(rosterToJson(entry)));
  await env.events.append({ agent: params.name, kind: "provisioned", data: { ...rosterToJson(entry) } });
  return entry;
}

export function rosterToJson(entry: AgentRosterEntry) {
  return {
    ...entry,
    agentId: entry.agentId.toString(),
  };
}
export function rosterFromJson(json: ReturnType<typeof rosterToJson>): AgentRosterEntry {
  return { ...json, agentId: BigInt(json.agentId) } as AgentRosterEntry;
}

/** Loads a previously provisioned agent's roster entry back out of the store. */
export async function loadRosterEntry(env: DemoEnv, name: string): Promise<AgentRosterEntry | undefined> {
  const raw = await env.store.get(`roster-${name}`);
  if (!raw) return undefined;
  return rosterFromJson(JSON.parse(raw));
}

/** Every provisioned agent's name, derived from the store's `roster-*` keys. */
export async function listRosterNames(env: DemoEnv): Promise<string[]> {
  const keys = await env.store.list();
  return keys.filter((k) => k.startsWith("roster-")).map((k) => k.slice("roster-".length));
}

function parseCliArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      persona: { type: "string" },
      "token-name": { type: "string" },
      "token-symbol": { type: "string" },
      "per-call-cap": { type: "string", default: "2000" },
      "max-auth-window": { type: "string", default: "300" },
      "llm-url": { type: "string" },
      "llm-model": { type: "string", default: "mistral-small-3-2-24b-instruct" },
      "data-url": { type: "string" },
      "underwriter-url": { type: "string", default: "http://localhost:8401" },
    },
  });
  if (!values.name || !values.persona || !values["token-name"] || !values["token-symbol"] || !values["llm-url"] || !values["data-url"]) {
    throw new Error("--name --persona --token-name --token-symbol --llm-url --data-url are required");
  }
  return values;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

if (isDirectRun()) {
  (async () => {
    const args = parseCliArgs(process.argv.slice(2));
    const env = await loadDemoEnv();
    const entry = await provisionAgent(env, {
      name: args.name!,
      persona: args.persona!,
      tokenName: args["token-name"]!,
      tokenSymbol: args["token-symbol"]!,
      perCallCap: BigInt(args["per-call-cap"]!),
      maxAuthWindow: BigInt(args["max-auth-window"]!),
      llmUrl: args["llm-url"]!,
      llmModel: args["llm-model"]!,
      dataUrl: args["data-url"]!,
      underwriterUrl: args["underwriter-url"]!,
    });
    console.log(JSON.stringify(rosterToJson(entry), null, 2));
  })().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
