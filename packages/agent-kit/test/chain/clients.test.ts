import { describe, expect, it } from "vitest";
import type { Hex, TransactionSerializable } from "viem";
import { dynamicAccount, walletClientFor, type ActionKeys } from "../../src/chain/clients.js";
import { base } from "viem/chains";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

function fakeKeys(overrides: Partial<ActionKeys> = {}): ActionKeys {
  return {
    async address(label: string) {
      return `0xaddr-${label}`;
    },
    async signTransaction(_label: string, _tx: TransactionSerializable) {
      return "0xsigned" as Hex;
    },
    ...overrides,
  };
}

describe("dynamicAccount", () => {
  it("delegates signTransaction to keys.signTransaction(label, tx)", async () => {
    let seen: { label: string; tx: TransactionSerializable } | undefined;
    const keys = fakeKeys({
      async signTransaction(label, tx) {
        seen = { label, tx };
        return "0xdeadbeef" as Hex;
      },
    });
    const account = dynamicAccount("treasury", ADDRESS, keys);
    const tx: TransactionSerializable = { to: "0x2222222222222222222222222222222222222222", value: 0n, chainId: 8453 };

    const signed = await account.signTransaction(tx);

    expect(signed).toEqual("0xdeadbeef");
    expect(seen?.label).toEqual("treasury");
    expect(seen?.tx).toEqual(tx);
  });

  it("exposes the given address and marks itself a local account", () => {
    const account = dynamicAccount("card-owner", ADDRESS, fakeKeys());
    expect(account.address).toEqual(ADDRESS);
    expect(account.type).toEqual("local");
  });

  it("refuses to sign messages - only signTransaction is used by chain/actions.ts", async () => {
    const account = dynamicAccount("treasury", ADDRESS, fakeKeys());
    await expect(account.signMessage({ message: "hello" })).rejects.toThrow(/signMessage/);
  });

  it("refuses to sign typed data - only signTransaction is used by chain/actions.ts", async () => {
    const account = dynamicAccount("treasury", ADDRESS, fakeKeys());
    await expect(
      account.signTypedData({ domain: {}, types: { X: [] }, primaryType: "X", message: {} } as never),
    ).rejects.toThrow(/signTypedData/);
  });
});

describe("walletClientFor", () => {
  it("resolves the label's address from keys and builds a client whose account carries it", async () => {
    const keys = fakeKeys({
      async address(label) {
        expect(label).toEqual("lenderA");
        return "0x3333333333333333333333333333333333333333";
      },
    });

    const client = await walletClientFor({
      chain: base,
      transport: () => ({ config: {}, request: async () => undefined }) as never,
      label: "lenderA",
      keys,
    });

    expect(client.account.address).toEqual("0x3333333333333333333333333333333333333333");
    expect(client.account.type).toEqual("local");
  });
});
