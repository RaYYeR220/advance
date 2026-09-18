/**
 * Records a deterministic fixture pair (`bankr.json` + `chain.json`) for one Doppler
 * token, by hitting the live Bankr API (Base mainnet only) and an archive-capable RPC for
 * the given chain, then running the engine's own `score()` over a recording `ChainOps` —
 * so a fixture always contains exactly what the engine actually reads, with no risk of a
 * hand-maintained call list drifting out of sync with `runStage1`.
 *
 * Usage (from `packages/core`):
 *   node --env-file=<path to your local .env> scripts/record-fixture.ts <token> [slug] [--chain=8453|84532]
 *
 * `BASE_RPC_URL`/`BASE_SEPOLIA_RPC_URL` must be set in the environment (an archive-capable
 * RPC, e.g. Alchemy) — `--env-file` is the recommended way to supply it without ever
 * printing or committing it. Falls back to the public defaults, which may reject archive
 * `eth_call`s at old blocks.
 *
 * Writes: test/fixtures/<slug>/bankr.json (mainnet only), test/fixtures/<slug>/chain.json.
 * Writes neither when the result is `data_unavailable` — that's a broken/incomplete
 * recording, not a fixture worth committing — the (URL-redacted) error is printed instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { chainAddresses, BASE_RPC_URL_DEFAULT, type SupportedChainId } from "../src/chains.js";
import {
  createBankrClient,
  createFixtureBankrClient,
  pickBankrToken,
  type BankrClient,
  type BankrTokenFeesResponse,
} from "../src/sources/bankr.js";
import { createLiveChainOps } from "../src/sources/chainOps.js";
import type { ChainFixture } from "../src/sources/chainFixture.js";
import { buildChainReader, type ChainReader } from "../src/sources/chainLogic.js";
import { score } from "../src/underwrite/engine.js";

const BASE_SEPOLIA_RPC_URL_DEFAULT = "https://sepolia.base.org";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "../test/fixtures");

/** Never let an RPC URL (or anything else that looks like one) reach stdout/stderr. */
function redactUrl(message: string): string {
  return message.replace(/(https?|wss?):\/\/\S+/gi, "[redacted]");
}

interface Args {
  token: Address;
  slug: string | undefined;
  chainId: SupportedChainId;
}

/** Strips every `--flag=value` argument first, then reads token/slug from the remaining
 * *positional* arguments only — so `--chain=84532` (or any future flag) can never be
 * accidentally parsed as the slug. Only the `--flag=value` form is accepted (matching the
 * documented usage); a bare `--chain 84532` would otherwise need lookahead that risks the
 * same positional-index confusion this is meant to avoid. */
function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  let chainId: SupportedChainId = 8453;

  for (const arg of argv) {
    if (arg.startsWith("--chain=")) {
      const raw = arg.slice("--chain=".length);
      const value = Number(raw);
      if (value !== 8453 && value !== 84532) {
        throw new Error(`--chain must be 8453 or 84532, got ${raw}`);
      }
      chainId = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  const token = positionals[0] as Address | undefined;
  if (!token) {
    throw new Error("usage: record-fixture.ts <token> [slug] [--chain=8453|84532]");
  }
  return { token, slug: positionals[1], chainId };
}

/** Bankr has no non-mainnet data; off Base mainnet the engine never calls it (discovery
 * is Airlock-only there), so a stub that throws if ever invoked is safe. */
function unreachableBankrClient(): BankrClient {
  return {
    async getTokenFees(token: Address) {
      throw new Error(
        `record-fixture: bankr client unexpectedly called for ${token} (non-mainnet chain)`,
      );
    },
  };
}

/**
 * `score()`'s recording layer keeps every chunk's own top-`cap` swaps (see
 * `createRecordingChainOps`'s `getSwapLogs`), which can still be more than the fixture
 * ever needs once merged across chunks and capped globally. This re-derives the exact
 * (blockNumber, logIndex) set that actually made the final capped result — one more live
 * `getSwaps` call, using the reader that already has every earlier read cached — and
 * trims `swapLogs` down to just those, the same global trim the engine's own consumer
 * (`chainLogic.ts#getSwaps`) applies at read time.
 */
async function trimSwapLogsToContributing(
  calls: ChainFixture["calls"],
  reader: ChainReader,
  poolManager: Address,
  poolId: Hex,
  swapSample: { fromBlock: bigint; toBlock: bigint; cap: number },
): Promise<void> {
  if (swapSample.cap === 0) return; // discovery/rules denied before swaps were ever read
  const swaps = await reader.getSwaps({
    poolManager,
    poolId,
    fromBlock: swapSample.fromBlock,
    toBlock: swapSample.toBlock,
    cap: swapSample.cap,
  });
  const contributingKeys = new Set(swaps.map((s) => `${s.blockNumber}:${s.logIndex}`));
  for (const key of Object.keys(calls.swapLogs)) {
    calls.swapLogs[key] = calls.swapLogs[key]!.filter((log) =>
      contributingKeys.has(`${log.blockNumber}:${log.logIndex}`),
    );
  }
}

async function main() {
  const { token, slug: slugArg, chainId } = parseArgs(process.argv.slice(2));

  const rpcUrl =
    process.env.BASE_RPC_URL_OVERRIDE ??
    (chainId === 8453
      ? (process.env.BASE_RPC_URL ?? BASE_RPC_URL_DEFAULT)
      : (process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC_URL_DEFAULT));

  let bankrForScoring: BankrClient;
  let bankrResponse: BankrTokenFeesResponse | undefined;
  let slug = slugArg;

  if (chainId === 8453) {
    // Fetched once, live; `score()` below reuses this exact response instead of hitting
    // the network a second time for the same token.
    const liveBankr = createBankrClient();
    bankrResponse = await liveBankr.getTokenFees(token);
    const entry = pickBankrToken(bankrResponse, token);
    slug = slug ?? entry.symbol.toLowerCase();
    bankrForScoring = createFixtureBankrClient(bankrResponse);
  } else {
    slug = slug ?? token.toLowerCase();
    bankrForScoring = unreachableBankrClient();
  }

  const outDir = resolve(fixturesRoot, slug);
  mkdirSync(outDir, { recursive: true });

  // `score()` wraps `deps.chain` in its own recording layer internally and exposes the
  // final result as `evidence.rawReads` — exactly the shape `ChainFixture.calls` needs,
  // and guaranteed to contain everything the engine actually read (never a hand-maintained
  // call list that can drift out of sync with `runStage1`).
  const liveOps = createLiveChainOps(rpcUrl);
  const result = await score(
    { token, agentCard: token, agentId: 0n, chainId, hub: token, now: Math.floor(Date.now() / 1000) },
    { bankr: bankrForScoring, chain: liveOps, env: { network: chainId === 8453 ? "mainnet" : "demo" } },
  );

  console.log(`score() result: kind=${result.kind}`);
  if (result.kind === "deny") {
    console.log(`  reasons: ${result.reasons.join(", ")}`);
  } else {
    console.log(`  capMicroUsd=${result.terms.capMicroUsd} haircutBps=${result.terms.haircutBps}`);
  }

  if (result.kind === "deny" && result.reasons.includes("data_unavailable")) {
    console.error(
      `record-fixture: data_unavailable — not writing a fixture from a broken/incomplete ` +
        `recording. error: ${redactUrl(result.evidence.error ?? "(no error message recorded)")}`,
    );
    process.exitCode = 1;
    return;
  }

  const reader = buildChainReader(liveOps);
  await trimSwapLogsToContributing(
    result.evidence.rawReads,
    reader,
    chainAddresses(chainId).poolManager,
    result.evidence.poolId,
    result.evidence.swapSample,
  );

  if (bankrResponse) {
    writeFileSync(
      resolve(outDir, "bankr.json"),
      JSON.stringify(bankrResponse, null, 2) + "\n",
    );
  }

  const chainFixture: ChainFixture = {
    token,
    chainId,
    recordedAt: new Date().toISOString(),
    calls: result.evidence.rawReads,
  };

  writeFileSync(
    resolve(outDir, "chain.json"),
    JSON.stringify(chainFixture, null, 2) + "\n",
  );

  console.log(`recorded fixture "${slug}" for token ${token} on chain ${chainId}`);
}

main().catch((err) => {
  console.error(redactUrl(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
