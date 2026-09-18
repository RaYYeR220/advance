import { createWalletClient, http, type Chain, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SignerResolver } from "./types.js";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Default `SignerResolver`: reads `ADVANCE_SIGNER` from `env` on every call (not cached), so a
 * value that starts, changes, or is unset after this process boots is picked up without a
 * restart. Only understands one form — a `0x`-prefixed private key, for local dev/testing.
 *
 * A non-hex-private-key value (an agent-kit Dynamic signer label, for example) resolves to
 * `undefined` here — this local resolver has nothing to look that up against. An agent runtime
 * that manages keys through Dynamic replaces this whole function (pass a different
 * `SignerResolver` to `buildAdvanceServer`) with one that turns the same `ADVANCE_SIGNER` label
 * into a Dynamic-backed `WalletClient`; the tools never know which resolver they got.
 */
export function envPrivateKeySigner(
  chain: Chain,
  rpcUrl: string,
  env: Record<string, string | undefined> = process.env,
): SignerResolver {
  return async () => {
    const value = env.ADVANCE_SIGNER;
    if (!value || !PRIVATE_KEY_PATTERN.test(value)) return undefined;
    const account = privateKeyToAccount(value as `0x${string}`);
    return createWalletClient({ account, chain, transport: http(rpcUrl) }) as WalletClient;
  };
}

/** A `SignerResolver` that never resolves a wallet — read-only deployments (or a server that
 * intentionally disables all write tools) pass this explicitly instead of relying on
 * `ADVANCE_SIGNER` being absent. */
export const noSigner: SignerResolver = async () => undefined;
