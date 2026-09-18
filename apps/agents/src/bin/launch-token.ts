#!/usr/bin/env node
/**
 * Token launch CLI.
 *
 * Base mainnet (8453): always a dry run. Prints the exact HTTP request
 * (endpoint, body, auth header name with the value redacted) that would be
 * sent to the Bankr token-launch API, with `feeRecipient` set to the
 * borrower agent's treasury. `--execute` is refused for mainnet in code —
 * not just by operator discipline — because a real launch spends funds and
 * creates a public asset that this CLI must never do unattended.
 *
 * Base Sepolia (84532): Doppler's Airlock
 * (0x3411306Ce66c9469BFF1535BA955503c4Bde1C6e) and DopplerHookInitializer
 * (0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544) are deployed there (verified
 * on-chain: both addresses return non-empty `eth_getCode`), so `--execute`
 * drives a real multicurve launch through the Doppler SDK with the fee
 * recipient set as the majority beneficiary. Without `--execute` it only
 * prints the launch plan.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseEther,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const BANKR_DEPLOY_URL = "https://api.bankr.bot/token-launches/deploy";

/** Doppler contract addresses deployed on Base Sepolia (84532), confirmed via `eth_getCode`. */
export const DOPPLER_SEPOLIA_ADDRESSES = {
  airlock: "0x3411306Ce66c9469BFF1535BA955503c4Bde1C6e" as Address,
  dopplerHookInitializer: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544" as Address,
  streamableFeesLockerV2: "0x0a13aE3DbEB8D332987706FE581600D4bc1a98b7" as Address,
} as const;

/** WETH on Base / Base Sepolia (same OP-stack predeploy address on both). */
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;

const WAD = 10n ** 18n;
/** Doppler's Airlock requires the protocol owner beneficiary to hold at least 5% of fee shares. */
const PROTOCOL_OWNER_MIN_SHARE = (WAD * 5n) / 100n;

export interface HttpRequestPlan {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface BankrLaunchParams {
  tokenName: string;
  tokenSymbol: string;
  /** Fee recipient wallet: the borrower agent's treasury, so trading fees back its loan. */
  feeRecipient: Address;
  chain?: "base" | "arbitrum" | "robinhood";
  pairedTokenAddress?: Address;
  disableVesting?: boolean;
  quoteOnlyFees?: boolean;
  degenMode?: boolean;
}

/**
 * Builds the exact Bankr token-launch HTTP request. Documented at
 * https://docs.bankr.bot/token-launching/overview/ (endpoint, method, and
 * the `feeRecipient: { type: "wallet", value }` body shape). The endpoint
 * and auth header are confirmed live: `GET https://api.bankr.bot/agent/me`
 * succeeds with `X-API-Key`, and
 * `OPTIONS https://api.bankr.bot/token-launches/deploy` returns 204.
 */
export function buildBankrLaunchRequest(params: BankrLaunchParams, apiKey: string): HttpRequestPlan {
  const body: Record<string, unknown> = {
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    chain: params.chain ?? "base",
    feeRecipient: { type: "wallet", value: params.feeRecipient },
  };
  if (params.pairedTokenAddress !== undefined) body.pairedTokenAddress = params.pairedTokenAddress;
  if (params.disableVesting !== undefined) body.disableVesting = params.disableVesting;
  if (params.quoteOnlyFees !== undefined) body.quoteOnlyFees = params.quoteOnlyFees;
  if (params.degenMode !== undefined) body.degenMode = params.degenMode;

  return {
    method: "POST",
    url: BANKR_DEPLOY_URL,
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body,
  };
}

/** Returns a copy of a request plan with sensitive header values replaced for safe printing/logging. */
export function redactRequestForPrint(
  request: HttpRequestPlan,
  sensitiveHeaders: string[] = ["X-API-Key", "Authorization"],
): HttpRequestPlan {
  const headers = { ...request.headers };
  for (const name of sensitiveHeaders) {
    if (headers[name]) headers[name] = "<redacted>";
  }
  return { ...request, headers };
}

export interface Beneficiary {
  beneficiary: Address;
  shares: bigint;
}

export interface DopplerLaunchPlan {
  chainId: 84532;
  airlock: Address;
  hookInitializer: Address;
  tokenName: string;
  tokenSymbol: string;
  numeraire: Address;
  migration: "noOp";
  /** Trading-fee beneficiaries; shares sum to WAD (1e18 = 100%). */
  beneficiaries: Beneficiary[];
}

export interface DopplerLaunchParams {
  tokenName: string;
  tokenSymbol: string;
  feeRecipient: Address;
  /** Airlock protocol owner, read on-chain via getAirlockOwner() before a real launch. */
  protocolOwner: Address;
}

/**
 * Builds a NoOp-migration multicurve launch plan on Base Sepolia: liquidity
 * stays in the pool (no migration) and trading fees stream to beneficiaries
 * — the borrower agent's treasury gets the majority share, the required
 * Airlock protocol-owner minimum (5%) goes to the protocol owner. Pure/no
 * network so it is safe to call for a dry-run print or in tests.
 */
export function buildDopplerLaunchPlan(params: DopplerLaunchParams): DopplerLaunchPlan {
  const protocolShare = PROTOCOL_OWNER_MIN_SHARE;
  const feeRecipientShare = WAD - protocolShare;
  return {
    chainId: 84532,
    airlock: DOPPLER_SEPOLIA_ADDRESSES.airlock,
    hookInitializer: DOPPLER_SEPOLIA_ADDRESSES.dopplerHookInitializer,
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    numeraire: WETH_ADDRESS,
    migration: "noOp",
    beneficiaries: [
      { beneficiary: params.protocolOwner, shares: protocolShare },
      { beneficiary: params.feeRecipient, shares: feeRecipientShare },
    ].sort((a, b) => (a.beneficiary.toLowerCase() < b.beneficiary.toLowerCase() ? -1 : 1)),
  };
}

export interface LaunchTokenArgs {
  chain: "base" | "base-sepolia";
  name: string;
  symbol: string;
  feeRecipient: Address;
  execute: boolean;
}

export interface LaunchTokenDeps {
  bankrApiKey?: string;
  sepoliaRpcUrl?: string;
  deployerPrivateKey?: `0x${string}`;
}

export interface LaunchTokenResult {
  executed: boolean;
  dryRun?: { request: HttpRequestPlan } | { plan: DopplerLaunchPlan };
  dopplerResult?: { poolId?: string; tokenAddress?: string; txHash?: string };
}

/**
 * Core launch logic, deps-injected for testing. `--execute` is refused for
 * mainnet unconditionally — this function throws before any network call is
 * made, regardless of what the caller passes.
 */
export async function runLaunchToken(
  args: LaunchTokenArgs,
  deps: LaunchTokenDeps = {},
): Promise<LaunchTokenResult> {
  if (args.chain === "base") {
    const apiKey = deps.bankrApiKey ?? "<BANKR_API_KEY not set>";
    const request = buildBankrLaunchRequest(
      { tokenName: args.name, tokenSymbol: args.symbol, feeRecipient: args.feeRecipient },
      apiKey,
    );
    if (args.execute) {
      throw new Error(
        "refusing --execute against Base mainnet: token launches spend funds and create a public asset; this CLI never does that unattended. Rerun without --execute to see the dry-run request.",
      );
    }
    return { executed: false, dryRun: { request } };
  }

  // base-sepolia
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(deps.sepoliaRpcUrl),
  });
  const { getAirlockOwner } = await import("@whetstone-research/doppler-sdk/evm");
  const protocolOwner = (await getAirlockOwner(publicClient)) as Address;
  const plan = buildDopplerLaunchPlan({
    tokenName: args.name,
    tokenSymbol: args.symbol,
    feeRecipient: args.feeRecipient,
    protocolOwner,
  });

  if (!args.execute) {
    return { executed: false, dryRun: { plan } };
  }

  if (!deps.deployerPrivateKey) {
    throw new Error("--execute on base-sepolia requires DEPLOYER_PRIVATE_KEY");
  }
  const account = privateKeyToAccount(deps.deployerPrivateKey);
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(deps.sepoliaRpcUrl) });

  const { DopplerSDK, MulticurveBuilder } = await import("@whetstone-research/doppler-sdk/evm");
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: baseSepolia.id });

  const builderParams = new MulticurveBuilder(baseSepolia.id)
    .tokenConfig({ name: plan.tokenName, symbol: plan.tokenSymbol, tokenURI: "" })
    .saleConfig({
      initialSupply: parseEther("1000000"),
      numTokensToSell: parseEther("900000"),
      numeraire: plan.numeraire,
    })
    .poolConfig({
      fee: 3000,
      tickSpacing: 8,
      curves: [
        { tickLower: 0, tickUpper: 240000, numPositions: 10, shares: parseEther("0.5") },
        { tickLower: 16000, tickUpper: 240000, numPositions: 10, shares: parseEther("0.5") },
      ],
      beneficiaries: plan.beneficiaries,
    })
    .withGovernance({ type: "default" })
    .withMigration({ type: "noOp" })
    .withUserAddress(account.address)
    .build();

  const result = await sdk.factory.createMulticurve(builderParams);
  return {
    executed: true,
    dopplerResult: {
      poolId: result.poolId,
      tokenAddress: result.tokenAddress,
      txHash: result.transactionHash,
    },
  };
}

function parseCliArgs(argv: string[]): LaunchTokenArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      chain: { type: "string", default: "base" },
      name: { type: "string", default: "Advance Demo Token" },
      symbol: { type: "string", default: "ADVDEMO" },
      "fee-recipient": { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  const chain = values.chain === "base-sepolia" ? "base-sepolia" : "base";
  const feeRecipient = values["fee-recipient"] ?? process.env.SERVICE_PAYTO;
  if (!feeRecipient || !isAddress(feeRecipient)) {
    throw new Error("--fee-recipient (or SERVICE_PAYTO) must be a valid 0x address");
  }
  return {
    chain,
    name: String(values.name),
    symbol: String(values.symbol),
    feeRecipient: feeRecipient as Address,
    execute: Boolean(values.execute),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runLaunchToken(args, {
    bankrApiKey: process.env.BANKR_API_KEY,
    sepoliaRpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
    deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined,
  });

  if (!result.executed && result.dryRun) {
    if ("request" in result.dryRun) {
      const printable = redactRequestForPrint(result.dryRun.request);
      console.log("DRY RUN — Bankr token launch (Base mainnet). No request was sent.");
      console.log(JSON.stringify(printable, null, 2));
    } else {
      console.log("DRY RUN — Doppler multicurve launch (Base Sepolia). Nothing was submitted on-chain.");
      console.log(
        JSON.stringify(result.dryRun.plan, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
      );
    }
    console.log("\nRerun with --execute to submit for real (refused for Base mainnet).");
    return;
  }

  console.log("EXECUTED", JSON.stringify(result, null, 2));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(fileURLToPath(import.meta.url)).toLowerCase() === resolvePath(entry).toLowerCase();
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
