import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, type Hex } from "viem";
import { cardSigner } from "../../src/card/signer.js";
import type { EvmTypedData } from "../../src/dynamic.js";

const CARD = "0x6d11186eb5aaec25a9eb57308ea26a757138b1be";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYEE = "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0";
const CHAIN_ID = 8453;
const NONCE = (`0x${"1".padStart(64, "0")}`) as Hex;

function fakeKeys(signature: Hex = "0xaaaa") {
  const calls: Array<{ label: string; typedData: EvmTypedData }> = [];
  return {
    calls,
    async signTypedData(label: string, typedData: EvmTypedData): Promise<Hex> {
      calls.push({ label, typedData });
      return signature;
    },
  };
}

function transferAuthTypedData(overrides: Partial<EvmTypedData["message"]> = {}): EvmTypedData {
  return {
    domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: CARD,
      to: PAYEE,
      value: 1000n,
      validAfter: 0n,
      validBefore: 1_800_000_000n,
      nonce: NONCE,
      ...overrides,
    },
  };
}

describe("cardSigner", () => {
  it("reports the card as its address, checksummed", () => {
    const signer = cardSigner(CARD, "agent-a", { keys: fakeKeys(), usdc: USDC, chainId: CHAIN_ID });
    expect(signer.address).toEqual(getAddress(CARD));
  });

  it("asks Dynamic for the owner signature under the given label and returns the abi-encoded blob", async () => {
    const ownerSig = "0xdeadbeef" as Hex;
    const keys = fakeKeys(ownerSig);
    const signer = cardSigner(CARD, "agent-a", { keys, usdc: USDC, chainId: CHAIN_ID });

    const blob = await signer.signTypedData(transferAuthTypedData());

    expect(keys.calls).toHaveLength(1);
    expect(keys.calls[0]!.label).toEqual("agent-a");
    expect(keys.calls[0]!.typedData.primaryType).toEqual("TransferWithAuthorization");

    const [decodedOwnerSig, to, value, validAfter, validBefore, nonce] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      blob,
    );
    expect(decodedOwnerSig).toEqual(ownerSig);
    expect(to).toEqual(getAddress(PAYEE));
    expect(value).toEqual(1000n);
    expect(validAfter).toEqual(0n);
    expect(validBefore).toEqual(1_800_000_000n);
    expect(nonce).toEqual(NONCE);
  });

  it("never calls Dynamic when primaryType isn't TransferWithAuthorization", async () => {
    const keys = fakeKeys();
    const signer = cardSigner(CARD, "agent-a", { keys, usdc: USDC, chainId: CHAIN_ID });
    const bad = transferAuthTypedData();
    bad.primaryType = "SomethingElse";

    await expect(signer.signTypedData(bad)).rejects.toThrow(/primaryType/);
    expect(keys.calls).toHaveLength(0);
  });

  it("never calls Dynamic when domain.verifyingContract isn't USDC", async () => {
    const keys = fakeKeys();
    const signer = cardSigner(CARD, "agent-a", { keys, usdc: USDC, chainId: CHAIN_ID });
    const bad = transferAuthTypedData();
    bad.domain = { ...bad.domain, verifyingContract: "0x000000000000000000000000000000000000dEaD" };

    await expect(signer.signTypedData(bad)).rejects.toThrow(/verifyingContract/);
    expect(keys.calls).toHaveLength(0);
  });

  it("never calls Dynamic when domain.chainId isn't this card's chain", async () => {
    const keys = fakeKeys();
    const signer = cardSigner(CARD, "agent-a", { keys, usdc: USDC, chainId: CHAIN_ID });
    const bad = transferAuthTypedData();
    bad.domain = { ...bad.domain, chainId: 84532 };

    await expect(signer.signTypedData(bad)).rejects.toThrow(/chainId/);
    expect(keys.calls).toHaveLength(0);
  });

  it("never calls Dynamic when message.from isn't the card", async () => {
    const keys = fakeKeys();
    const signer = cardSigner(CARD, "agent-a", { keys, usdc: USDC, chainId: CHAIN_ID });
    const bad = transferAuthTypedData({ from: "0x000000000000000000000000000000000000dEaD" });

    await expect(signer.signTypedData(bad)).rejects.toThrow(/message\.from/);
    expect(keys.calls).toHaveLength(0);
  });

  it("is not fooled by a checksum/case mismatch on verifyingContract or from", async () => {
    const keys = fakeKeys("0xcafe" as Hex);
    const signer = cardSigner(CARD, "agent-a", { keys, usdc: USDC, chainId: CHAIN_ID });
    const td = transferAuthTypedData({ from: CARD.toUpperCase().replace("0X", "0x") });
    td.domain = { ...td.domain, verifyingContract: USDC.toLowerCase() };

    await expect(signer.signTypedData(td)).resolves.toBeDefined();
    expect(keys.calls).toHaveLength(1);
  });
});
