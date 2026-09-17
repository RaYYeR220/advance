import { describe, expect, it } from "vitest";
import { decryptShares, encryptShares } from "../src/crypto.js";

const KEY_A = "11".repeat(32); // 32-byte hex key
const KEY_B = "22".repeat(32); // different 32-byte hex key

describe("encryptShares / decryptShares", () => {
  it("round-trips arbitrary JSON-serializable share data", () => {
    const shares = [
      { index: 0, share: "abc123", meta: { curve: "secp256k1" } },
      { index: 1, share: "def456", meta: { curve: "secp256k1" } },
    ];

    const encrypted = encryptShares(shares, KEY_A);
    expect(encrypted.ciphertext).not.toContain("abc123");

    const decrypted = decryptShares<typeof shares>(encrypted, KEY_A);
    expect(decrypted).toEqual(shares);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const shares = { share: "same-input" };
    const first = encryptShares(shares, KEY_A);
    const second = encryptShares(shares, KEY_A);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.iv).not.toEqual(second.iv);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptShares({ share: "secret" }, KEY_A);
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + (encrypted.ciphertext.slice(-2) === "00" ? "11" : "00"),
    };
    expect(() => decryptShares(tampered, KEY_A)).toThrow();
  });

  it("throws on tampered auth tag", () => {
    const encrypted = encryptShares({ share: "secret" }, KEY_A);
    const tampered = {
      ...encrypted,
      authTag: encrypted.authTag.slice(0, -2) + (encrypted.authTag.slice(-2) === "00" ? "11" : "00"),
    };
    expect(() => decryptShares(tampered, KEY_A)).toThrow();
  });

  it("throws when decrypting with the wrong key", () => {
    const encrypted = encryptShares({ share: "secret" }, KEY_A);
    expect(() => decryptShares(encrypted, KEY_B)).toThrow();
  });

  it("rejects an encryption key that is not 32 bytes of hex", () => {
    expect(() => encryptShares({ share: "x" }, "not-hex")).toThrow();
    expect(() => encryptShares({ share: "x" }, "aa")).toThrow();
  });
});
