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
  /** HTTP transport bind host. Absent ⇒ loopback-only (`127.0.0.1`), no auth required — the
   * server is only reachable from this machine. Present (any value, including `127.0.0.1` again)
   * ⇒ the operator is making a deliberate choice to change how this binds, so `MCP_AUTH_TOKEN`
   * becomes required and every request must carry it. */
  MCP_BIND_HOST: z.string().min(1).optional(),
  /** Bearer token required on every HTTP request once `MCP_BIND_HOST` is set. Never logged. */
  MCP_AUTH_TOKEN: z.string().min(1).optional(),
  /** Comma-separated hostnames or full origin URLs allowed through the `Origin`/`Host`
   * DNS-rebinding checks, in addition to the built-in localhost defaults. */
  MCP_ALLOWED_ORIGINS: z.string().optional(),
});

/** The bind host used when `MCP_BIND_HOST` is unset — loopback-only, no auth required. */
const DEFAULT_BIND_HOST = "127.0.0.1";

/** Always allowed, regardless of `MCP_ALLOWED_ORIGINS` — the loopback names a default,
 * unauthenticated bind is reachable under. */
const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", DEFAULT_BIND_HOST, "::1"];

/** Extracts a bare hostname from either a full origin URL (`https://example.com:3000`) or an
 * already-bare hostname (`example.com`) — `MCP_ALLOWED_ORIGINS` accepts either form. An entry
 * that isn't a parseable URL is dropped rather than guessed at — fails closed: better to reject a
 * legitimate origin that was mistyped than to silently widen the allowlist. */
function toHostname(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  return trimmed.toLowerCase();
}

function parseAllowedOriginHostnames(value: string | undefined): string[] {
  const extra = (value ?? "")
    .split(",")
    .map(toHostname)
    .filter((h): h is string => h !== undefined);
  return [...new Set([...DEFAULT_ALLOWED_HOSTNAMES, ...extra])];
}

export interface McpConfig {
  chainId: SupportedChainId;
  rpcUrl: string;
  apiUrl: string;
  hub: `0x${string}`;
  port?: number;
  /** HTTP bind host — `127.0.0.1` unless `MCP_BIND_HOST` overrides it. */
  host: string;
  /** Whether `MCP_BIND_HOST` was explicitly set — the trigger for requiring `authToken`. */
  hostExplicit: boolean;
  authToken?: string;
  /** Hostnames the `Origin`/`Host` DNS-rebinding checks accept; always includes the localhost
   * defaults plus whatever `MCP_ALLOWED_ORIGINS` added. */
  allowedOriginHostnames: string[];
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
    host: config.MCP_BIND_HOST ?? DEFAULT_BIND_HOST,
    hostExplicit: config.MCP_BIND_HOST !== undefined,
    authToken: config.MCP_AUTH_TOKEN,
    allowedOriginHostnames: parseAllowedOriginHostnames(config.MCP_ALLOWED_ORIGINS),
  };
}
