import { z } from "zod";

const addressPattern = /^0x[a-fA-F0-9]{40}$/;

const envSchema = z.object({
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1).optional(),
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  SERVICE_PAYTO: z.string().regex(addressPattern, "SERVICE_PAYTO must be a 0x-prefixed 20-byte address"),
  CHAIN_ID: z.coerce.number().int().positive(),
  REDTEAM: z
    .string()
    .optional()
    .transform((value) => value === "1"),
});

export type AgentsConfig = Readonly<z.infer<typeof envSchema>>;

/**
 * Parses and validates the agents-service environment. Fails closed: any
 * missing/malformed field throws rather than falling back to a guessed
 * default (except the documented X402_FACILITATOR_URL/REDTEAM defaults).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AgentsConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid agents config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** USDC token addresses for the two chains this repo supports (Base + Base Sepolia). */
export const USDC_BY_CHAIN: Readonly<Record<number, `0x${string}`>> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/**
 * USDC's on-chain EIP-712 domain (name, version), required by the exact
 * scheme's transferWithAuthorization signature. Confirmed on-chain via
 * `name()`/`version()`: Base mainnet USDC reports "USD Coin" (matches the
 * Bankr 402 body's extra field); Base Sepolia's USDC test deployment reports
 * the shorter "USDC". Both report EIP-712 version "2".
 */
export const USDC_EIP712_DOMAIN_BY_CHAIN: Readonly<Record<number, { name: string; version: string }>> = {
  8453: { name: "USD Coin", version: "2" },
  84532: { name: "USDC", version: "2" },
};

/** Resolves the USDC address for a chain id, failing closed on unknown chains. */
export function usdcAddressForChain(chainId: number): `0x${string}` {
  const address = USDC_BY_CHAIN[chainId];
  if (!address) {
    throw new Error(`no USDC address configured for chain ${chainId}`);
  }
  return address;
}

/** Resolves USDC's EIP-712 domain (name/version) for a chain id, failing closed on unknown chains. */
export function usdcEip712DomainForChain(chainId: number): { name: string; version: string } {
  const domain = USDC_EIP712_DOMAIN_BY_CHAIN[chainId];
  if (!domain) {
    throw new Error(`no USDC EIP-712 domain configured for chain ${chainId}`);
  }
  return domain;
}

/** Builds the CAIP-2 network id x402 expects (e.g. "eip155:84532"). */
export function networkForChain(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`;
}
