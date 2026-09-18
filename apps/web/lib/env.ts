import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";

/** Chain ids Advance is deployed on — Base mainnet and Base Sepolia. Kept as a local literal
 * union (rather than importing `@advance/core`'s equivalent) so the web app's only workspace
 * dependency for chain reads is `@advance/sdk` itself. */
export type SupportedChainId = 8453 | 84532;

export interface WebEnv {
  chainId: SupportedChainId;
  rpcUrl: string;
  hub: Address;
  /** Underwriter API base URL, no trailing slash. */
  underwriterApiUrl: string;
  /** JSON feed of off-chain agent events. Absent means on-chain events only. */
  eventsUrl?: string;
  /** Enables listing an off-chain events feed from Vercel Blob instead of/alongside
   * `eventsUrl`. Absent means on-chain events only. */
  blobReadWriteToken?: string;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Parses and validates the web app's server-side environment. Every page/route that reads
 * chain or underwriter state goes through this, so a missing or malformed value fails loudly
 * once, here, rather than producing a page that silently renders wrong or empty data.
 */
export function loadWebEnv(env: Record<string, string | undefined> = process.env): WebEnv {
  const chainIdRaw = env.NEXT_PUBLIC_CHAIN_ID ?? "84532";
  const chainId = Number(chainIdRaw);
  if (chainId !== 8453 && chainId !== 84532) {
    throw new Error(`invalid NEXT_PUBLIC_CHAIN_ID: "${chainIdRaw}" (must be 8453 or 84532)`);
  }

  const rpcUrl =
    chainId === 8453 ? env.BASE_RPC_URL || "https://mainnet.base.org" : env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

  const hub = env.ADVANCE_HUB;
  if (!hub || !ADDRESS_PATTERN.test(hub)) {
    throw new Error("ADVANCE_HUB must be set to a 0x-prefixed 20-byte address");
  }

  const underwriterApiUrl = env.UNDERWRITER_API_URL;
  if (!underwriterApiUrl) {
    throw new Error("UNDERWRITER_API_URL must be set");
  }

  return {
    chainId,
    rpcUrl,
    hub: hub as Address,
    underwriterApiUrl: trimTrailingSlash(underwriterApiUrl),
    eventsUrl: env.EVENTS_URL || undefined,
    blobReadWriteToken: env.BLOB_READ_WRITE_TOKEN || undefined,
  };
}

let cachedClient: { chainId: SupportedChainId; rpcUrl: string; client: PublicClient } | undefined;

/** A process-wide viem `PublicClient` for `chainId`/`rpcUrl`, rebuilt only when either
 * changes. Constructing a viem client never itself makes a network call, so this is cheap and
 * safe to call from any server context (route handler, server component, cron). */
export function getPublicClient(target: Pick<WebEnv, "chainId" | "rpcUrl">): PublicClient {
  if (cachedClient && cachedClient.chainId === target.chainId && cachedClient.rpcUrl === target.rpcUrl) {
    return cachedClient.client;
  }
  const chain: Chain = target.chainId === 8453 ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(target.rpcUrl) });
  cachedClient = { chainId: target.chainId, rpcUrl: target.rpcUrl, client };
  return client;
}

/** Test-only: drops the cached public client so the next `getPublicClient` call builds a
 * fresh one. */
export function resetPublicClientCache(): void {
  cachedClient = undefined;
}
