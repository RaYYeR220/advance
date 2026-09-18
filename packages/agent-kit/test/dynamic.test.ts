import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptShares } from "../src/crypto.js";
import { DynamicKeys, type DynamicClient } from "../src/dynamic.js";
import { FileStore } from "../src/store.js";

const ENCRYPTION_KEY = "33".repeat(32);

/** In-memory fake standing in for the real Dynamic MPC client (no native module, no network). */
function fakeDynamicClient(): DynamicClient & { calls: { signTypedData: number; signTransaction: number } } {
  let counter = 0;
  const calls = { signTypedData: 0, signTransaction: 0 };
  return {
    calls,
    async createWalletAccount() {
      counter += 1;
      return {
        walletMetadata: {
          walletId: `wallet-${counter}`,
          accountAddress: `0xaddr${counter}`,
          chainName: "EVM",
        },
        externalServerKeyShares: [{ share: `share-${counter}`, index: 0 }],
      };
    },
    async signTypedData({ walletMetadata, externalServerKeyShares }) {
      calls.signTypedData += 1;
      return `0xtyped:${walletMetadata.accountAddress}:${JSON.stringify(externalServerKeyShares)}` as `0x${string}`;
    },
    async signTransaction({ walletMetadata, externalServerKeyShares }) {
      calls.signTransaction += 1;
      return `0xtx:${walletMetadata.accountAddress}:${JSON.stringify(externalServerKeyShares)}` as `0x${string}`;
    },
  };
}

let dir: string;
let store: FileStore;
let client: ReturnType<typeof fakeDynamicClient>;
let keys: DynamicKeys;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-kit-dynamic-"));
  store = new FileStore(dir);
  client = fakeDynamicClient();
  keys = new DynamicKeys(client, store, ENCRYPTION_KEY);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DynamicKeys", () => {
  it("creates a key and persists walletMetadata + encrypted shares", async () => {
    const result = await keys.createKey("treasury");
    expect(result.address).toEqual("0xaddr1");

    const raw = await store.get("treasury");
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!);
    expect(record.walletMetadata.accountAddress).toEqual("0xaddr1");
    // shares must not be stored in the clear anywhere in the record
    expect(JSON.stringify(record)).not.toContain("share-1");

    const decrypted = decryptShares(record.encryptedShares, ENCRYPTION_KEY);
    expect(decrypted).toEqual([{ share: "share-1", index: 0 }]);
  });

  it("refuses to create a key for a label that already exists", async () => {
    await keys.createKey("treasury");
    await expect(keys.createKey("treasury")).rejects.toThrow();
  });

  it("creates independent keys for different labels", async () => {
    const treasury = await keys.createKey("treasury");
    const card = await keys.createKey("card");
    expect(treasury.address).not.toEqual(card.address);
  });

  it("returns the address for a known label", async () => {
    await keys.createKey("treasury");
    expect(await keys.address("treasury")).toEqual("0xaddr1");
  });

  it("throws for an unknown label on address()", async () => {
    await expect(keys.address("nope")).rejects.toThrow();
  });

  it("signs typed data using shares decrypted from the store", async () => {
    await keys.createKey("card");
    const typedData = {
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0xusdc" },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: "0xaddr1" },
    };
    const sig = await keys.signTypedData("card", typedData);
    expect(sig).toContain("0xtyped:0xaddr1:");
    expect(sig).toContain("share-1");
    expect(client.calls.signTypedData).toEqual(1);
  });

  it("signs a transaction using shares decrypted from the store", async () => {
    await keys.createKey("card");
    const sig = await keys.signTransaction("card", { to: "0xdead", value: 0n, chainId: 84532 });
    expect(sig).toContain("0xtx:0xaddr1:");
    expect(client.calls.signTransaction).toEqual(1);
  });

  it("throws for an unknown label on signTypedData()", async () => {
    await expect(
      keys.signTypedData("nope", { domain: {}, types: {}, primaryType: "X", message: {} }),
    ).rejects.toThrow();
  });

  it("throws for an unknown label on signTransaction()", async () => {
    await expect(keys.signTransaction("nope", { to: "0xdead" })).rejects.toThrow();
  });
});
