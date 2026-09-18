import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import type { EvidenceBundle } from "@advance/core";
import { toJsonSafe } from "./jsonSafe.js";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const JSON_SUFFIX = ".json";

/** Evidence files older than this are swept on the next `save()` call. Seven days
 * comfortably covers "look up the decision behind a quote/score I just got" — the
 * practical lifetime this store needs to serve — without holding every bundle forever. */
const EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on files kept on disk. Each bundle is a few KB of JSON, so 5,000 files is low
 * tens of MB regardless of TTL — bounds disk usage against a flood of distinct evidence
 * hashes (every score/quote call that reaches the engine writes one, content-addressed,
 * so a flood of distinct token addresses or quote requests means a flood of distinct
 * files). */
const EVIDENCE_MAX_ENTRIES = 5_000;

export interface EvidenceStore {
  /** Writes `bundle` under `hash`, idempotently (a second `save` for the same hash is a
   * no-op — the content is content-addressed, so there is never anything to overwrite). */
  save(hash: Hex, bundle: EvidenceBundle): void;
  /** Returns the bigint-safe (string-encoded) canonical JSON previously saved under `hash`,
   * or `undefined` if nothing is stored there (including a malformed `hash`). */
  get(hash: Hex): unknown | undefined;
}

export interface FileEvidenceStoreOptions {
  /** Injectable clock (ms), for deterministic TTL tests. Default `Date.now`. */
  now?: () => number;
  /** Evidence TTL in ms. Default `EVIDENCE_TTL_MS` (7 days). */
  ttlMs?: number;
  /** Hard cap on files kept on disk. Default `EVIDENCE_MAX_ENTRIES` (5,000); overridable
   * for tests that want to exercise cap eviction without 5,000 fixtures. */
  maxEntries?: number;
}

function isWellFormedHash(hash: string): hash is Hex {
  return HASH_PATTERN.test(hash);
}

function fileNameFor(hash: Hex): string {
  return `${hash.slice(2).toLowerCase()}${JSON_SUFFIX}`;
}

function hashFromFileName(fileName: string): Hex {
  return `0x${fileName.slice(0, -JSON_SUFFIX.length)}` as Hex;
}

/** File-backed evidence store: one JSON file per evidence hash under `dir`, created if it
 * doesn't already exist. Every decision (approve and deny) gets one — content-addressed by
 * `evidenceHash`, so re-hashing a fetched bundle always reproduces the same hash.
 *
 * Growth is bounded two ways (both swept on every genuinely new `save()`, never on `get`):
 * a TTL (`ttlMs`, default 7 days) and a hard entry cap (`maxEntries`, default 5,000, oldest
 * evicted first) — see the constants above for the numbers and their reasoning. Bookkeeping
 * ("when was this hash saved") is kept in an in-memory index, not re-derived from file
 * mtimes on every call: it's seeded once from the directory's existing files at startup
 * (using their mtime, so a restarted process doesn't forget pre-existing entries) and kept
 * exactly thereafter from `now()`, which is what makes TTL/cap behavior deterministic to
 * test rather than dependent on OS mtime granularity.
 */
export function createFileEvidenceStore(dir: string, options: FileEvidenceStoreOptions = {}): EvidenceStore {
  mkdirSync(dir, { recursive: true });
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? EVIDENCE_TTL_MS;
  const maxEntries = options.maxEntries ?? EVIDENCE_MAX_ENTRIES;

  const savedAt = new Map<Hex, number>();
  try {
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith(JSON_SUFFIX)) continue;
      try {
        savedAt.set(hashFromFileName(fileName), statSync(join(dir, fileName)).mtimeMs);
      } catch {
        // Vanished between readdir and stat, or unreadable — skip it; not fatal to start.
      }
    }
  } catch {
    // Best-effort seed only; an unreadable dir here just starts with an empty index (the
    // `mkdirSync` above already guarantees the dir itself exists).
  }

  function removeFile(hash: Hex): void {
    try {
      rmSync(join(dir, fileNameFor(hash)), { force: true });
    } catch {
      // Best-effort eviction; a failed delete here never blocks the save that triggered it.
    }
  }

  /** Drops anything already past `ttlMs`, then — if still over `maxEntries` — evicts the
   * oldest-saved entries until back at the cap. Only called from `save()`, and only when a
   * genuinely new hash is about to be written (an idempotent re-save of an existing hash
   * returns before this runs) — so its frequency tracks distinct new evidence, not reads. */
  function sweepAndCap(t: number): void {
    for (const [hash, savedAtMs] of savedAt) {
      if (t - savedAtMs > ttlMs) {
        savedAt.delete(hash);
        removeFile(hash);
      }
    }
    if (savedAt.size <= maxEntries) return;
    const oldestFirst = [...savedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [hash] of oldestFirst.slice(0, savedAt.size - maxEntries)) {
      savedAt.delete(hash);
      removeFile(hash);
    }
  }

  return {
    save(hash, bundle) {
      if (!isWellFormedHash(hash)) {
        throw new Error("evidence store: refusing to save under a malformed hash");
      }
      const file = join(dir, fileNameFor(hash));
      if (existsSync(file)) return;
      const t = now();
      writeFileSync(file, `${JSON.stringify(toJsonSafe(bundle), null, 2)}\n`);
      savedAt.set(hash, t);
      // Sweeps/caps *after* recording this save, not before — the cap must account for the
      // entry just written, or a save that pushes the count one over the limit would never
      // actually trigger eviction (the check would still see the pre-save count).
      sweepAndCap(t);
    },

    get(hash) {
      if (!isWellFormedHash(hash)) return undefined;
      const file = join(dir, fileNameFor(hash));
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    },
  };
}
