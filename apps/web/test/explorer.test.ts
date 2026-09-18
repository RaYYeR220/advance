import { describe, expect, it } from "vitest";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  addressUrl,
  blockUrl,
  chainName,
  explorerOrigin,
  tokenUrl,
  txUrl,
} from "@/lib/explorer";

const address = "0x2C88aa11bb22cc33dd44ee55ff66007788a9f301";
const hash = "0x5e1d4b7a0c2e9f8d6b3a1c5e7f9d2b4a6c8e0f1a3b5d7c9e1f2a4b6c8d0ea94c";

describe("explorer links", () => {
  it("picks Basescan by chain id", () => {
    expect(explorerOrigin(BASE_MAINNET)).toBe("https://basescan.org");
    expect(explorerOrigin(BASE_SEPOLIA)).toBe("https://sepolia.basescan.org");
  });

  it("builds transaction, address, token and block links", () => {
    expect(txUrl(BASE_MAINNET, hash)).toBe(`https://basescan.org/tx/${hash}`);
    expect(addressUrl(BASE_SEPOLIA, address)).toBe(
      "https://sepolia.basescan.org/address/0x2c88aa11bb22cc33dd44ee55ff66007788a9f301",
    );
    expect(tokenUrl(BASE_MAINNET, address)).toBe(
      "https://basescan.org/token/0x2c88aa11bb22cc33dd44ee55ff66007788a9f301",
    );
    expect(blockUrl(BASE_MAINNET, 18_204_113)).toBe("https://basescan.org/block/18204113");
    expect(blockUrl(BASE_SEPOLIA, 18_204_113n)).toBe("https://sepolia.basescan.org/block/18204113");
  });

  it("names the chain", () => {
    expect(chainName(BASE_MAINNET)).toBe("Base mainnet");
    expect(chainName(BASE_SEPOLIA)).toBe("Base Sepolia");
  });

  it("refuses unknown chains", () => {
    expect(() => explorerOrigin(1)).toThrow(RangeError);
    expect(() => chainName(10)).toThrow(RangeError);
  });

  it("refuses malformed input", () => {
    expect(() => txUrl(BASE_MAINNET, "0x1234")).toThrow(TypeError);
    expect(() => addressUrl(BASE_MAINNET, "not-an-address")).toThrow(TypeError);
    expect(() => blockUrl(BASE_MAINNET, -3)).toThrow(RangeError);
  });
});
