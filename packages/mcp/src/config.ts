import { z } from "zod";
import type { SupportedChainId } from "@advance/core";
import { ADDRESS_PATTERN } from "./json.js";

const envSchema = z.object({
  CHAIN_ID: z.preprocess(
    (v) => (typeof v === "string" ? Number(v) : v),
    z.union([z.literal(8453), z.literal(84532)]),
  ),
  BASE_RPC_URL: z.string().url().default("https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  /** Base URL of the underwriter API this server quotes/scores against (no trailing slash). */
  ADVANCE_API_URL: z.string().url(),
  ADVANCE_HUB: z.string().regex(ADDRESS_PATTERN, "ADVANCE_HUB must be a 0x-prefixed 20-byte address"),
  /** A `0x`-prefixed private key for local dev, or an agent-kit Dynamic signer label an injected
   * `SignerResolver` knows how to resolve. Absent or unrecognized ⇒ write tools return a
   * structured error; read tools are unaffected. Never logged, never echoed in a tool result. */
  ADVANCE_SIGNER: z.string().optional(),
  /** JSON feed URL `advance_explain_refusal`'s default `RefusalSource` reads. Absent ⇒ that one
   * tool reports itself unavailable; every other tool is unaffected. */
  ADVANCE_EVENTS_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().optional(),
});

export interface McpConfig {
  chainId: SupportedChainId;
  rpcUrl: string;
  apiUrl: string;
  hub: `0x${string}`;
  port?: number;
}

/**
 * Parses and validates this server's environment. Fails closed: a missing or malformed
 * required field throws rather than letting the server boot half-configured — better to refuse
 * to start than to serve a `/mcp` endpoint whose tools fail on every call.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid advance-mcp config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const config = parsed.data;
  const chainId = config.CHAIN_ID as SupportedChainId;
  const rpcUrl = chainId === 8453 ? config.BASE_RPC_URL : config.BASE_SEPOLIA_RPC_URL;
  return {
    chainId,
    rpcUrl,
    apiUrl: config.ADVANCE_API_URL,
    hub: config.ADVANCE_HUB as `0x${string}`,
    port: config.PORT,
  };
}
