import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // recommended GCM nonce size

/**
 * AES-256-GCM ciphertext for encrypted Dynamic server key shares, stored as hex
 * so the whole payload is plain JSON-serializable.
 */
export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

function decodeKey(encryptionKeyHex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(encryptionKeyHex)) {
    throw new Error("WALLET_ENCRYPTION_KEY must be a hex string");
  }
  const key = Buffer.from(encryptionKeyHex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`WALLET_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/** Encrypts any JSON-serializable value (Dynamic external server key shares). */
export function encryptShares(plaintext: unknown, encryptionKeyHex: string): EncryptedPayload {
  const key = decodeKey(encryptionKeyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

/** Decrypts a payload produced by {@link encryptShares}. Throws if the key is wrong or the payload was tampered with. */
export function decryptShares<T = unknown>(payload: EncryptedPayload, encryptionKeyHex: string): T {
  const key = decodeKey(encryptionKeyHex);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
