import { z } from "zod";
import type { SupportedChainId } from "@advance/core";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const envSchema = z.object({
  CHAIN_ID: z.preprocess(
    (v) => (typeof v === "string" ? Number(v) : v),
    z.union([z.literal(8453), z.literal(84532)]),
  ),
  BASE_RPC_URL: z.string().url().default("https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  UNDERWRITER_PRIVATE_KEY: z
    .string()
    .regex(PRIVATE_KEY_PATTERN, "UNDERWRITER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string"),
  ADVANCE_HUB: z.string().regex(ADDRESS_PATTERN, "ADVANCE_HUB must be a 0x-prefixed 20-byte address"),
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1),
  EVIDENCE_DIR: z.string().min(1),
  NETWORK: z.enum(["mainnet", "demo"]),
  PORT: z.coerce.number().int().positive().optional(),
  /** Receives the 0.05 USDC quote fee (`POST /v1/quote`'s x402 `payTo`). */
  UNDERWRITER_PAYTO: z.string().regex(ADDRESS_PATTERN, "UNDERWRITER_PAYTO must be a 0x-prefixed 20-byte address"),
  /** x402 facilitator this service verifies/settles quote payments against. The public
   * reference facilitator is a reasonable default for testnet; a real deployment should
   * point this at an operator-controlled facilitator. */
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  /** Off by default: the rate limiter keys on the real socket address, which a client
   * cannot spoof. Set to "1" only when this service always runs behind a proxy/load
   * balancer that sets `X-Forwarded-For` itself — turning it on in front of an untrusted
   * client lets that client mint unlimited rate-limit buckets by spoofing the header. */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value) => value === "1"),
  /** Unset by default (no bypass possible). When set, a `POST /v1/quote` request carrying
   * this exact value in `X-Internal-Key` skips the x402 gate — used only by the Bankr x402
   * Cloud forwarder (`apps/underwriter-x402`), which has already collected payment on its
   * own edge before relaying the request here. */
  UNDERWRITER_INTERNAL_KEY: z.string().min(1).optional(),
});

export type UnderwriterConfig = Readonly<z.infer<typeof envSchema>>;

/**
 * Parses and validates the underwriter service environment. Fails closed: a missing or
 * malformed field throws, and so does a `CHAIN_ID`/`NETWORK` combination the engine itself
 * would reject on every request (8453 must be "mainnet", 84532 must not be) — better to
 * refuse to boot than to serve a service that can never process a single request.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): UnderwriterConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid underwriter config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const config = parsed.data;
  if (config.CHAIN_ID === 8453 && config.NETWORK !== "mainnet") {
    throw new Error(`invalid underwriter config: CHAIN_ID 8453 requires NETWORK "mainnet", got "${config.NETWORK}"`);
  }
  if (config.CHAIN_ID === 84532 && config.NETWORK === "mainnet") {
    throw new Error('invalid underwriter config: CHAIN_ID 84532 must not use NETWORK "mainnet"');
  }
  return config;
}

/** The archive RPC URL configured for `config.CHAIN_ID` — `BASE_RPC_URL` for 8453,
 * `BASE_SEPOLIA_RPC_URL` for 84532. Never mixes the two. */
export function rpcUrlForChain(config: UnderwriterConfig): string {
  const chainId: SupportedChainId = config.CHAIN_ID;
  return chainId === 8453 ? config.BASE_RPC_URL : config.BASE_SEPOLIA_RPC_URL;
}
