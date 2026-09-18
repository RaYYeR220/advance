import { randomBytes } from "node:crypto";
import type { Hex, TransactionSerializable } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { decryptShares, encryptShares, type EvmTypedData, type Store } from "@advance/agent-kit";

/**
 * Same custody interface `DynamicKeys` exposes (`createKey`/`address`/`signTypedData`/
 * `signTransaction`), backed by a locally generated private key instead of a real Dynamic MPC
 * wallet. Every other line of `chain/actions.ts`, `card/signer.ts` and `brain/loop.ts` is
 * structurally typed against this same shape, so swapping this in for `DynamicKeys` requires no
 * change anywhere else.
 *
 * Exists because live Dynamic `signTransaction` hit a reproducible third-party SDK defect in this
 * runtime (see the seed-sepolia report): `signTypedData` and key creation verified live and
 * working, but `signTransaction` failed on every attempt across two different
 * `@dynamic-labs-wallet/forward-mpc-client` dependency resolutions, with two different
 * SDK-internal errors. An `AgentCard`'s owner must be one consistent signer for both roles
 * (`drawCredit` needs `signTransaction`; x402 needs `signTypedData`), so a broken
 * `signTransaction` path rules out Dynamic for the operational treasury/owner keys entirely, not
 * just for the calls that happen to need it.
 */
export interface KeyCustody {
  createKey(label: string): Promise<{ address: string }>;
  address(label: string): Promise<string>;
  signTypedData(label: string, typedData: EvmTypedData): Promise<Hex>;
  signTransaction(label: string, transaction: TransactionSerializable): Promise<Hex>;
}

export class LocalKeyCustody implements KeyCustody {
  private readonly cache = new Map<string, PrivateKeyAccount>();

  constructor(
    private readonly store: Store,
    private readonly encryptionKeyHex: string,
  ) {}

  async createKey(label: string): Promise<{ address: string }> {
    const existing = await this.store.get(this.keyFor(label));
    if (existing !== undefined) {
      throw new Error(`LocalKeyCustody: a key already exists for label "${label}"`);
    }
    const privateKey = `0x${randomBytes(32).toString("hex")}` as Hex;
    const account = privateKeyToAccount(privateKey);
    const encrypted = encryptShares(privateKey, this.encryptionKeyHex);
    await this.store.set(this.keyFor(label), JSON.stringify(encrypted));
    this.cache.set(label, account);
    return { address: account.address };
  }

  async address(label: string): Promise<string> {
    return (await this.load(label)).address;
  }

  async signTypedData(label: string, typedData: EvmTypedData): Promise<Hex> {
    const account = await this.load(label);
    // `EvmTypedData` is structurally the same shape viem's `signTypedData` expects.
    return account.signTypedData(typedData as Parameters<PrivateKeyAccount["signTypedData"]>[0]);
  }

  async signTransaction(label: string, transaction: TransactionSerializable): Promise<Hex> {
    const account = await this.load(label);
    return account.signTransaction(transaction);
  }

  private keyFor(label: string): string {
    return `local-${label}`;
  }

  private async load(label: string): Promise<PrivateKeyAccount> {
    const cached = this.cache.get(label);
    if (cached) return cached;
    const raw = await this.store.get(this.keyFor(label));
    if (raw === undefined) {
      throw new Error(`LocalKeyCustody: no key stored for label "${label}"`);
    }
    const privateKey = decryptShares<Hex>(JSON.parse(raw), this.encryptionKeyHex);
    const account = privateKeyToAccount(privateKey);
    this.cache.set(label, account);
    return account;
  }
}
