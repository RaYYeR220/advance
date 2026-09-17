import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import type { EvidenceBundle } from "@advance/core";
import { toJsonSafe } from "./jsonSafe.js";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface EvidenceStore {
  /** Writes `bundle` under `hash`, idempotently (a second `save` for the same hash is a
   * no-op — the content is content-addressed, so there is never anything to overwrite). */
  save(hash: Hex, bundle: EvidenceBundle): void;
  /** Returns the bigint-safe (string-encoded) canonical JSON previously saved under `hash`,
   * or `undefined` if nothing is stored there (including a malformed `hash`). */
  get(hash: Hex): unknown | undefined;
}

function isWellFormedHash(hash: string): hash is Hex {
  return HASH_PATTERN.test(hash);
}

function fileNameFor(hash: Hex): string {
  return `${hash.slice(2).toLowerCase()}.json`;
}

/** File-backed evidence store: one JSON file per evidence hash under `dir`, created if it
 * doesn't already exist. Every decision (approve and deny) gets one — content-addressed by
 * `evidenceHash`, so re-hashing a fetched bundle always reproduces the same hash. */
export function createFileEvidenceStore(dir: string): EvidenceStore {
  mkdirSync(dir, { recursive: true });

  return {
    save(hash, bundle) {
      if (!isWellFormedHash(hash)) {
        throw new Error("evidence store: refusing to save under a malformed hash");
      }
      const file = join(dir, fileNameFor(hash));
      if (existsSync(file)) return;
      writeFileSync(file, `${JSON.stringify(toJsonSafe(bundle), null, 2)}\n`);
    },

    get(hash) {
      if (!isWellFormedHash(hash)) return undefined;
      const file = join(dir, fileNameFor(hash));
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    },
  };
}
