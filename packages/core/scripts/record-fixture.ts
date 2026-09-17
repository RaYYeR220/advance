/**
 * Records a deterministic fixture pair (`bankr.json` + `chain.json`) for one Bankr/Doppler
 * token, by hitting the live Bankr API and an archive-capable Base RPC.
 *
 * Usage (from `packages/core`):
 *   node --env-file=../../../internal/.env scripts/record-fixture.ts <token> [slug]
 *
 * `BASE_RPC_URL` must be set in the environment (an archive-capable RPC, e.g. Alchemy) —
 * `--env-file` is the recommended way to supply it without ever printing or committing it.
 * If unset, falls back to the public default (`https://mainnet.base.org`), which may reject
 * archive `eth_call`s at old blocks.
 *
 * Writes: test/fixtures/<slug>/bankr.json, test/fixtures/<slug>/chain.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import {
  BASE_ETH_USD_CHAINLINK_FEED,
  BASE_MAINNET_CHAIN_ID,
  BASE_RPC_URL_DEFAULT,
  BASE_V4_POOL_MANAGER,
  BASE_WETH,
} from "../src/chains.js";
import { createBankrClient, pickBankrToken } from "../src/sources/bankr.js";
import { createLiveChainOps } from "../src/sources/chainOps.js";
import { createRecordingChainOps } from "../src/sources/chainFixture.js";
import { buildChainReader } from "../src/sources/chainLogic.js";
import { checkIsWethPool, computeRevenue } from "../src/underwrite/revenue.js";

const DAY_SECONDS = 86_400n;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "../test/fixtures");

async function main() {
  const token = process.argv[2] as Address | undefined;
  if (!token) {
    console.error("usage: record-fixture.ts <token> [slug]");
    process.exit(1);
  }

  const rpcUrl = process.env.BASE_RPC_URL ?? BASE_RPC_URL_DEFAULT;

  const bankr = createBankrClient();
  const bankrResponse = await bankr.getTokenFees(token);
  const entry = pickBankrToken(bankrResponse, token);

  const slug = process.argv[3] ?? entry.symbol.toLowerCase();
  const outDir = resolve(fixturesRoot, slug);
  mkdirSync(outDir, { recursive: true });

  const liveOps = createLiveChainOps(rpcUrl);
  const { ops, dump } = createRecordingChainOps(liveOps, {
    token,
    chainId: BASE_MAINNET_CHAIN_ID,
  });
  const reader = buildChainReader(ops);

  const feesManager = entry.initializer;
  const poolId = entry.poolId;
  const creator = bankrResponse.address;

  const latest = await reader.getLatestBlock();
  const poolKey = await reader.getPoolKey(feesManager, poolId);
  await reader.getShares(feesManager, poolId, creator);

  const createdAt = await reader.tokenCreatedAt(token);
  console.log(
    `  tokenCreatedAt: block=${createdAt.block} timestamp=${createdAt.timestamp} (${new Date(createdAt.timestamp * 1000).toISOString()})`,
  );

  const isWethPaired = await checkIsWethPool(reader, feesManager, poolId, BASE_WETH);

  let contributingSwapKeys: Set<string> | undefined;

  if (isWethPaired) {
    // Records every call `computeRevenue` makes — the 1d/7d/30d windows, the 8 daily
    // block anchors + fee-accrual reads behind the 7 on-chain CV buckets, tokenCreatedAt,
    // and the ETH/USD read — so fixtures always match exactly what production code needs.
    const revenue = await computeRevenue(reader, {
      token,
      feesManager,
      poolId,
      creator,
      weth: BASE_WETH,
      ethUsdFeed: BASE_ETH_USD_CHAINLINK_FEED,
      atBlock: latest.number,
    });
    console.log(
      `  revenueWei d1=${Number(revenue.revenueWei.d1) / 1e18} d7=${
        Number(revenue.revenueWei.d7) / 1e18
      } d30=${Number(revenue.revenueWei.d30) / 1e18}`,
    );
    console.log(
      `  dailyRevenueWei (oldest..newest): ${revenue.dailyRevenueWei
        .map((w) => Number(w) / 1e18)
        .join(", ")}`,
    );

    const swapFromTimestamp = latest.timestamp - 7n * DAY_SECONDS;
    const swapFromBlock = await reader.blockAt(swapFromTimestamp);
    const swaps = await reader.getSwaps({
      poolManager: BASE_V4_POOL_MANAGER,
      poolId,
      fromBlock: swapFromBlock,
      toBlock: latest.number,
      cap: 400,
    });
    console.log(`  recorded ${swaps.length} swaps over trailing 7d`);

    // Only the swaps that actually made the final (capped) result matter for replay —
    // every other raw log fetched along the way is discardable. Trimming to exactly
    // this set keeps fixtures for busy pools well under a megabyte.
    contributingSwapKeys = new Set(
      swaps.map((s) => `${s.blockNumber}:${s.logIndex}`),
    );
  } else {
    console.log(
      `  ${slug}: not WETH-paired (currency0=${poolKey.currency0} currency1=${poolKey.currency1}) — skipping revenue/swap/price calls`,
    );
  }

  const chainFixture = dump();
  if (contributingSwapKeys) {
    for (const key of Object.keys(chainFixture.calls.swapLogs)) {
      chainFixture.calls.swapLogs[key] = chainFixture.calls.swapLogs[
        key
      ]!.filter((log) =>
        contributingSwapKeys!.has(`${log.blockNumber}:${log.logIndex}`),
      );
    }
  }

  writeFileSync(
    resolve(outDir, "bankr.json"),
    JSON.stringify(bankrResponse, null, 2) + "\n",
  );
  writeFileSync(
    resolve(outDir, "chain.json"),
    JSON.stringify(chainFixture, null, 2) + "\n",
  );

  console.log(`recorded fixture "${slug}" for token ${token} at block ${latest.number}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
