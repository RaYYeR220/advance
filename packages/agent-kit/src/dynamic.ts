import type { Hex, TransactionSerializable } from "viem";
import { decryptShares, encryptShares, type EncryptedPayload } from "./crypto.js";
import type { Store } from "./store.js";

/** Non-sensitive wallet metadata Dynamic returns for a server wallet. Safe to persist unencrypted. */
export type WalletMetadataRecord = Record<string, unknown> & { accountAddress: string };

/** EIP-712 typed-data envelope, structurally compatible with viem's and Dynamic's shapes. */
export interface EvmTypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Everything `DynamicKeys` needs from a Dynamic MPC client. Kept independent of
 * `@dynamic-labs-wallet/node-evm`'s own types so unit tests can inject a fake
 * implementation without ever importing the native module.
 */
export interface DynamicClient {
  createWalletAccount(): Promise<{
    walletMetadata: WalletMetadataRecord;
    externalServerKeyShares: unknown[];
  }>;
  signTypedData(params: {
    walletMetadata: WalletMetadataRecord;
    externalServerKeyShares: unknown[];
    typedData: EvmTypedData;
  }): Promise<Hex>;
  signTransaction(params: {
    walletMetadata: WalletMetadataRecord;
    externalServerKeyShares: unknown[];
    transaction: TransactionSerializable;
  }): Promise<Hex>;
}

interface StoredKeyRecord {
  walletMetadata: WalletMetadataRecord;
  encryptedShares: EncryptedPayload;
}

/**
 * Custody for per-agent Dynamic MPC server wallets, addressed by a caller-chosen
 * label (e.g. "treasury", "card"). Wallet metadata is stored as-is; the MPC
 * external server key shares are AES-256-GCM encrypted before they touch the
 * store.
 */
export class DynamicKeys {
  constructor(
    private readonly client: DynamicClient,
    private readonly store: Store,
    private readonly encryptionKeyHex: string,
  ) {}

  async createKey(label: string): Promise<{ address: string }> {
    const existing = await this.store.get(label);
    if (existing !== undefined) {
      throw new Error(`DynamicKeys: a key already exists for label "${label}"`);
    }

    const { walletMetadata, externalServerKeyShares } = await this.client.createWalletAccount();
    const encryptedShares = encryptShares(externalServerKeyShares, this.encryptionKeyHex);
    const record: StoredKeyRecord = { walletMetadata, encryptedShares };
    await this.store.set(label, JSON.stringify(record));
    return { address: walletMetadata.accountAddress };
  }

  async address(label: string): Promise<string> {
    const record = await this.loadRecord(label);
    return record.walletMetadata.accountAddress;
  }

  async signTypedData(label: string, typedData: EvmTypedData): Promise<Hex> {
    const { walletMetadata, shares } = await this.loadForSigning(label);
    return this.client.signTypedData({ walletMetadata, externalServerKeyShares: shares, typedData });
  }

  async signTransaction(label: string, transaction: TransactionSerializable): Promise<Hex> {
    const { walletMetadata, shares } = await this.loadForSigning(label);
    return this.client.signTransaction({ walletMetadata, externalServerKeyShares: shares, transaction });
  }

  private async loadRecord(label: string): Promise<StoredKeyRecord> {
    const raw = await this.store.get(label);
    if (raw === undefined) {
      throw new Error(`DynamicKeys: no key stored for label "${label}"`);
    }
    return JSON.parse(raw) as StoredKeyRecord;
  }

  private async loadForSigning(label: string): Promise<{ walletMetadata: WalletMetadataRecord; shares: unknown[] }> {
    const record = await this.loadRecord(label);
    const shares = decryptShares<unknown[]>(record.encryptedShares, this.encryptionKeyHex);
    return { walletMetadata: record.walletMetadata, shares };
  }
}

/**
 * Minimal surface of `DynamicEvmWalletClient` this adapter drives. Declared
 * locally instead of imported: `@dynamic-labs-wallet/{node,node-evm}` ship
 * `.d.ts` files with extensionless relative specifiers (e.g. `./src/index`
 * instead of `./src/index.js`), which `moduleResolution: "NodeNext"` cannot
 * resolve - `import type { DynamicEvmWalletClient } from "..."` fails with
 * "has no exported member" even though the class exists and works fine at
 * runtime (verified against the live API). Tracked as an upstream packaging
 * bug, not a design choice.
 */
interface LiveSdkClient {
  authenticateApiToken(token: string): Promise<unknown>;
  createWalletAccount(params: {
    thresholdSignatureScheme: unknown;
    backUpToDynamic: boolean;
  }): Promise<{ walletMetadata: WalletMetadataRecord; externalServerKeyShares: unknown[] }>;
  signTypedData(params: { walletMetadata: unknown; externalServerKeyShares: unknown; typedData: unknown }): Promise<string>;
  signTransaction(params: {
    walletMetadata: unknown;
    externalServerKeyShares: unknown;
    transaction: unknown;
  }): Promise<string>;
}

/**
 * Live adapter: authenticates against Dynamic and wraps `DynamicEvmWalletClient`
 * behind {@link DynamicClient}. Every import of `@dynamic-labs-wallet/node-evm`
 * (and the native MPC binary it loads) is deferred to inside this function, so
 * merely importing this module never touches the native module — only calling
 * `createLiveDynamicClient()` does. That binary only ships for linux/darwin, so
 * this must run inside the Linux container, never on the Windows host.
 */
export async function createLiveDynamicClient(config: {
  environmentId: string;
  apiToken: string;
}): Promise<DynamicClient> {
  // `any`-typed on purpose: see the LiveSdkClient doc comment above.
  const [nodeEvmModule, nodeModule]: [any, any] = await Promise.all([
    import("@dynamic-labs-wallet/node-evm"),
    import("@dynamic-labs-wallet/node"),
  ]);

  const sdkClient: LiveSdkClient = new nodeEvmModule.DynamicEvmWalletClient({
    environmentId: config.environmentId,
  });
  await sdkClient.authenticateApiToken(config.apiToken);
  const thresholdSignatureScheme: unknown = nodeModule.ThresholdSignatureScheme.TWO_OF_TWO;

  return {
    async createWalletAccount() {
      const { walletMetadata, externalServerKeyShares } = await sdkClient.createWalletAccount({
        thresholdSignatureScheme,
        backUpToDynamic: false,
      });
      return { walletMetadata, externalServerKeyShares };
    },
    async signTypedData({ walletMetadata, externalServerKeyShares, typedData }) {
      const signature = await sdkClient.signTypedData({ walletMetadata, externalServerKeyShares, typedData });
      return signature as Hex;
    },
    async signTransaction({ walletMetadata, externalServerKeyShares, transaction }) {
      const signature = await sdkClient.signTransaction({ walletMetadata, externalServerKeyShares, transaction });
      return signature as Hex;
    },
  };
}
