/**
 * Records a deterministic fixture pair (`bankr.json` + `chain.json`) for one Doppler
 * token, by hitting the live Bankr API (Base mainnet only) and an archive-capable RPC for
 * the given chain, then running the engine's own `score()` over a recording `ChainOps` —
 * so a fixture always contains exactly what the engine actually reads, with no risk of a
 * hand-maintained call list drifting out of sync with `runStage1`.
 *
 * Usage (from `packages/core`):
 *   node --env-file=../../../internal/.env scripts/record-fixture.ts <token> [slug] [--chain=8453|84532]
 *
 * `BASE_RPC_URL`/`BASE_SEPOLIA_RPC_URL` must be set in the environment (an archive-capable
 * RPC, e.g. Alchemy) — `--env-file` is the recommended way to supply it without ever
 * printing or committing it. Falls back to the public defaults, which may reject archive
 * `eth_call`s at old blocks.
 *
 * Writes: test/fixtures/<slug>/bankr.json (mainnet only), test/fixtures/<slug>/chain.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { BASE_RPC_URL_DEFAULT, type SupportedChainId } from "../src/chains.js";
import { createBankrClient, pickBankrToken, type BankrClient } from "../src/sources/bankr.js";
import { createLiveChainOps } from "../src/sources/chainOps.js";
import type { ChainFixture } from "../src/sources/chainFixture.js";
import { score } from "../src/underwrite/engine.js";

const BASE_SEPOLIA_RPC_URL_DEFAULT = "https://sepolia.base.org";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "../test/fixtures");

function parseChainFlag(argv: string[]): SupportedChainId {
  const flag = argv.find((a) => a.startsWith("--chain="));
  if (!flag) return 8453;
  const value = Number(flag.slice("--chain=".length));
  if (value !== 8453 && value !== 84532) {
    throw new Error(`--chain must be 8453 or 84532, got ${flag}`);
  }
  return value;
}

/** Bankr has no non-mainnet data; off Base mainnet the engine never calls it (discovery
 * is Airlock-only there), so a stub that throws if ever invoked is safe. */
function unreachableBankrClient(): BankrClient {
  return {
    async getTokenFees(token: Address) {
      throw new Error(`record-fixture: bankr client unexpectedly called for ${token} (non-mainnet chain)`);
    },
  };
}

async function main() {
  const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const token = positionals[0] as Address | undefined;
  if (!token) {
    console.error("usage: record-fixture.ts <token> [slug] [--chain=8453|84532]");
    process.exit(1);
  }
  const chainId = parseChainFlag(process.argv.slice(2));

  const rpcUrl =
    process.env.BASE_RPC_URL_OVERRIDE ??
    (chainId === 8453
      ? (process.env.BASE_RPC_URL ?? BASE_RPC_URL_DEFAULT)
      : (process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC_URL_DEFAULT));

  let bankr: BankrClient;
  let slug: string;
  if (chainId === 8453) {
    const liveBankr = createBankrClient();
    const bankrResponse = await liveBankr.getTokenFees(token);
    const entry = pickBankrToken(bankrResponse, token);
    slug = process.argv[3]?.startsWith("--") ? entry.symbol.toLowerCase() : (process.argv[3] ?? entry.symbol.toLowerCase());
    const outDir = resolve(fixturesRoot, slug);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, "bankr.json"),
      JSON.stringify(bankrResponse, null, 2) + "\n",
    );
    bankr = liveBankr;
  } else {
    slug = process.argv[3]?.startsWith("--") ? token.toLowerCase() : (process.argv[3] ?? token.toLowerCase());
    bankr = unreachableBankrClient();
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
    { bankr, chain: liveOps, env: { network: chainId === 8453 ? "mainnet" : "demo" } },
  );

  console.log(`score() result: kind=${result.kind}`);
  if (result.kind === "deny") {
    console.log(`  reasons: ${result.reasons.join(", ")}`);
  } else {
    console.log(
      `  capMicroUsd=${result.terms.capMicroUsd} haircutBps=${result.terms.haircutBps}`,
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
  console.error(err);
  process.exit(1);
});
