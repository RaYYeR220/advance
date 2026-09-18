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

const KEY_HEX_CHARS = KEY_BYTES * 2;

function decodeKey(encryptionKeyHex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(encryptionKeyHex)) {
    throw new Error("WALLET_ENCRYPTION_KEY must be a hex string");
  }
  // Check the *source string's* length before decoding. Buffer.from(str,
  // "hex") silently drops a trailing unpaired hex digit instead of
  // throwing, so a 65-char string would otherwise decode to a "valid"
  // 32-byte buffer and pass a post-decode length check with the wrong key.
  if (encryptionKeyHex.length !== KEY_HEX_CHARS) {
    throw new Error(
      `WALLET_ENCRYPTION_KEY must be exactly ${KEY_HEX_CHARS} hex characters (${KEY_BYTES} bytes), got ${encryptionKeyHex.length}`,
    );
  }
  return Buffer.from(encryptionKeyHex, "hex");
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
