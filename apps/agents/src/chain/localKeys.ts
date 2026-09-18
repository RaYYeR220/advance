import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex, TransactionSerializable } from "viem";
import type { ActionKeys } from "@advance/agent-kit";

/**
 * An {@link ActionKeys} backed by plain local private keys instead of Dynamic MPC wallets - for
 * labels that never need custody-grade key protection because they only ever pay gas for
 * permissionless calls (settleAuction/harvest/markDefault/claim) or bid with the deployer's own
 * funds. Never used for an agent's treasury or card-owner label, which always resolve through a
 * real `DynamicKeys` instance instead.
 */
export function localKeys(accounts: Record<string, `0x${string}`>): ActionKeys {
  const byLabel = new Map<string, PrivateKeyAccount>();
  function accountFor(label: string): PrivateKeyAccount {
    let account = byLabel.get(label);
    if (!account) {
      const pk = accounts[label];
      if (!pk) throw new Error(`localKeys: no private key configured for label "${label}"`);
      account = privateKeyToAccount(pk);
      byLabel.set(label, account);
    }
    return account;
  }

  return {
    async address(label: string) {
      return accountFor(label).address;
    },
    async signTransaction(label: string, transaction: TransactionSerializable): Promise<Hex> {
      return accountFor(label).signTransaction(transaction);
    },
  };
}

/**
 * Retries `fn` when it fails with a transient nonce race (a concurrent sender using the same
 * deployer key, or a "pending" nonce read that hasn't caught up with the previous send yet) -
 * "nonce too low", "replacement transaction underpriced", "already known" - or a downstream read
 * that landed on an RPC replica lagging behind the write a prior step in the same call just made
 * (a just-confirmed approval a `TransferFromFailed` pull can't see yet, a beneficiary share an
 * `EscrowNotBeneficiary` check can't see yet). Re-runs the whole operation (not just the
 * broadcast) so both a fresh nonce and a fresh read are picked up on each attempt. Any other error
 * propagates immediately.
 */
export async function withNonceRetry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 3000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/underpriced|nonce too low|already known|nonce.*too low|TransferFromFailed|0x7939f424|EscrowNotBeneficiary/i.test(message)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Retries `fn` after a transient Dynamic forward-MPC signing failure (a session timeout, or the
 * key-mismatch error that Dynamic's own fallback path can throw after one) - a fresh call
 * re-establishes its own signing session rather than reusing whatever state the failed attempt
 * left behind.
 */
export async function withDynamicSigningRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 4000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/mismatch between the public keys|REQUEST_TIMEOUT|SessionRequestTimeoutError|forward mpc/i.test(message)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Combines a {@link localKeys} map with a real `DynamicKeys`-shaped delegate: any label present
 * in `locals` resolves locally, everything else resolves through `dynamic`. Lets one
 * `ActionContext` drive both the deployer/keeper's plain key and an agent's real Dynamic MPC
 * treasury/owner keys without the caller ever branching on which is which.
 */
export function combinedKeys(dynamic: ActionKeys, locals: Record<string, `0x${string}`>): ActionKeys {
  const local = localKeys(locals);
  return {
    async address(label: string) {
      if (label in locals) return local.address(label);
      return dynamic.address(label);
    },
    async signTransaction(label: string, transaction: TransactionSerializable): Promise<Hex> {
      if (label in locals) return local.signTransaction(label, transaction);
      return dynamic.signTransaction(label, transaction);
    },
  };
}
