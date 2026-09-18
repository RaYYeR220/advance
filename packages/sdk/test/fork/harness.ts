/**
 * Spins up an anvil fork of Base and deploys a fresh Advance stack onto it (via
 * `contracts/script/DeploySdkFixture.s.sol`) for the SDK's contract-level tests. Doppler/CCA
 * infrastructure is mocked (see that script and `contracts/script/sdk/SdkFixtures.sol`); Permit2
 * is real, at its canonical address, which is exactly why this forks Base rather than running a
 * bare local chain.
 *
 * `BASE_RPC_URL` must be set in the environment (an archive-capable RPC, e.g. a paid provider —
 * the public default rejects archive `eth_call`s at old blocks). It is never logged, thrown in an
 * error message, or otherwise surfaced — only ever handed to the `anvil` child process's
 * environment.
 */
import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { platform } from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(here, "../../../../contracts");
const FIXTURE_OUT_PATH = resolve(CONTRACTS_DIR, "script/sdk/out/fixture.json");

/** Matches `contracts/foundry.toml`'s `[profile.fork]` — reusing the same pinned block keeps the
 * fork's underlying RPC responses cacheable/consistent with the rest of this repo's fork tests. */
const FORK_BLOCK_NUMBER = 51403692;

/** Asks the OS for a free TCP port (binds to port `0`, reads what it got, releases it) — a fresh
 * port per harness instance, so a slow-to-release previous anvil process can never make a new
 * run hang waiting to bind an already-taken fixed port. */
async function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePromise(address.port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

/** Never let an RPC URL (or anything that looks like one) reach a thrown message or stdout. */
function redactUrl(message: string): string {
  return message.replace(/(https?|wss?):\/\/\S+/gi, "[redacted]");
}

function readBaseRpcUrl(): string {
  const value = process.env.BASE_RPC_URL;
  if (value && value.length > 0) return value;
  throw new Error("BASE_RPC_URL is not set in the environment — required for the anvil-fork suite");
}

export interface AnvilAccount {
  address: Address;
  privateKey: Hex;
}

function anvilChainFor(rpcUrl: string): Chain {
  return {
    id: 31337,
    name: "anvil-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/** Parses anvil's own startup banner for its "Available Accounts" addresses and matching
 * "Private Keys" — never hand-maintained, so it's exactly right for whatever mnemonic/derivation
 * this anvil version defaults to. */
function parseAnvilAccounts(banner: string): AnvilAccount[] {
  const addressByIndex = new Map<number, Address>();
  const keyByIndex = new Map<number, Hex>();
  let section: "accounts" | "keys" | undefined;

  for (const line of banner.split(/\r?\n/)) {
    if (line.startsWith("Available Accounts")) {
      section = "accounts";
      continue;
    }
    if (line.startsWith("Private Keys")) {
      section = "keys";
      continue;
    }
    if (/^[A-Z][A-Za-z ]+$/.test(line.trim()) && !line.trim().startsWith("(")) {
      // Any other all-caps banner heading (e.g. "Wallet", "Base Fee") ends whichever list we're in.
      if (line.trim() !== "Available Accounts" && line.trim() !== "Private Keys") section = undefined;
    }
    const accountMatch = section === "accounts" ? /^\((\d+)\)\s+(0x[0-9a-fA-F]{40})/.exec(line) : null;
    if (accountMatch) {
      addressByIndex.set(Number(accountMatch[1]), accountMatch[2] as Address);
      continue;
    }
    const keyMatch = section === "keys" ? /^\((\d+)\)\s+(0x[0-9a-fA-F]{64})/.exec(line) : null;
    if (keyMatch) {
      keyByIndex.set(Number(keyMatch[1]), keyMatch[2] as Hex);
    }
  }

  const indices = [...addressByIndex.keys()].sort((a, b) => a - b);
  const accounts: AnvilAccount[] = [];
  for (const index of indices) {
    const address = addressByIndex.get(index);
    const privateKey = keyByIndex.get(index);
    if (address && privateKey) accounts.push({ address, privateKey });
  }
  if (accounts.length === 0) {
    throw new Error("could not parse any accounts out of anvil's startup banner");
  }
  return accounts;
}

async function waitForAnvilReady(
  proc: ChildProcessByStdio<null, Readable, Readable>,
): Promise<AnvilAccount[]> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("anvil did not report ready within 60s"));
    }, 60_000);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!settled && /Listening on/.test(buffer)) {
        settled = true;
        clearTimeout(timeout);
        proc.stdout.off("data", onData);
        try {
          resolvePromise(parseAnvilAccounts(buffer));
        } catch (err) {
          reject(err);
        }
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`anvil exited early with code ${code}`));
      }
    });
  });
}

/** `anvil_setCode(addr, "0x")` on every account this harness will use as an EOA — anvil's
 * well-known default accounts can carry real EIP-7702 delegation code on Base (see
 * `contracts/foundry.toml`'s fork profile notes), which would make them behave like contracts
 * instead of plain signers. */
async function clear7702Code(rpcUrl: string, addresses: Address[]): Promise<void> {
  for (const address of addresses) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setCode", params: [address, "0x"] }),
    });
    const body = (await res.json()) as { error?: { message: string } };
    if (body.error) {
      throw new Error(`anvil_setCode(${address}) failed: ${body.error.message}`);
    }
  }
}

export interface SdkFixture {
  hub: Address;
  usdc: Address;
  weth: Address;
  agentToken: Address;
  feesManager: Address;
  ccaFactory: Address;
  router: Address;
  ethUsdFeed: Address;
  escrowDeployer: Address;
  loanDeployer: Address;
  agentCard: Address;
  permit2: Address;
  poolId: Hex;
}

function runForgeScript(rpcUrl: string, deployerPrivateKey: Hex, env: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "forge",
      ["script", "script/DeploySdkFixture.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", deployerPrivateKey],
      { cwd: CONTRACTS_DIR, env: { ...process.env, ...env } },
    );
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`forge script DeploySdkFixture failed (exit ${code}): ${redactUrl(stderr.slice(-4000))}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

export interface ForkHarness {
  publicClient: PublicClient;
  accounts: {
    deployer: AnvilAccount;
    underwriter: AnvilAccount;
    treasury: AnvilAccount;
    cardOwner: AnvilAccount;
    payee: AnvilAccount;
    lender: AnvilAccount;
  };
  fixture: SdkFixture;
  walletFor(account: AnvilAccount): WalletClient;
  stop(): Promise<void>;
}

/** Starts anvil forking Base, deploys the SDK fixture stack onto it, and returns clients plus the
 * deployed addresses. Call `stop()` when done (kills the anvil process). */
export async function startForkHarness(): Promise<ForkHarness> {
  const baseRpcUrl = readBaseRpcUrl();
  const port = await findFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  mkdirSync(dirname(FIXTURE_OUT_PATH), { recursive: true });
  if (existsSync(FIXTURE_OUT_PATH)) rmSync(FIXTURE_OUT_PATH);

  const proc = spawn(
    "anvil",
    [
      "--port",
      String(port),
      "--fork-url",
      baseRpcUrl,
      "--fork-block-number",
      String(FORK_BLOCK_NUMBER),
      "--hardfork",
      "cancun",
      // Fixed regardless of the forked network's own id, so the hub's EIP-712 domain (captured
      // at construction from `block.chainid`) is a known constant the test can sign against.
      "--chain-id",
      "31337",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let accounts: AnvilAccount[];
  try {
    accounts = await waitForAnvilReady(proc);
  } catch (err) {
    proc.kill();
    throw err;
  }

  const [deployer, underwriter, treasury, cardOwner, payee, lender] = accounts;
  if (!deployer || !underwriter || !treasury || !cardOwner || !payee || !lender) {
    proc.kill();
    throw new Error("anvil did not expose enough default accounts for the fork fixture");
  }

  await clear7702Code(
    rpcUrl,
    [deployer, underwriter, treasury, cardOwner, payee, lender].map((a) => a.address),
  );

  try {
    await runForgeScript(rpcUrl, deployer.privateKey, {
      UNDERWRITER: underwriter.address,
      OWNER: deployer.address,
      TREASURY: treasury.address,
      CARD_OWNER: cardOwner.address,
      PAYEE: payee.address,
    });
  } catch (err) {
    proc.kill();
    throw err;
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_OUT_PATH, "utf8")) as SdkFixture;

  const anvilChain = anvilChainFor(rpcUrl);
  const publicClient = createPublicClient({ chain: anvilChain, transport: http(rpcUrl) }) as PublicClient;

  function walletFor(account: AnvilAccount): WalletClient {
    return createWalletClient({
      account: privateKeyToAccount(account.privateKey),
      chain: anvilChain,
      transport: http(rpcUrl),
    });
  }

  return {
    publicClient,
    accounts: { deployer, underwriter, treasury, cardOwner, payee, lender },
    fixture,
    walletFor,
    async stop() {
      proc.kill();
      // `child_process.kill()` alone is not always reliable for terminating anvil promptly on
      // Windows (the port can otherwise stay bound past this call, which previously made a
      // closely-following harness startup hang waiting to bind it) — `taskkill /T /F` forces the
      // whole process tree down. Best-effort: ignore failures (e.g. anvil already exited, or
      // this isn't Windows).
      if (platform === "win32" && proc.pid) {
        await new Promise<void>((res) => {
          execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], () => res());
        });
      }
      await new Promise<void>((res) => {
        proc.once("exit", () => res());
        setTimeout(res, 2000);
      });
    },
  };
}
