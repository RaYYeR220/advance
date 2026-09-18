import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Minimal async key-value store used to persist wallet metadata + encrypted shares. */
export interface Store {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

const DEFAULT_DIR = ".data";
const EXTENSION = ".json";

/** JSON-on-disk {@link Store}. One file per key, one directory per store. */
export class FileStore implements Store {
  readonly directory: string;

  constructor(directory: string = DEFAULT_DIR) {
    this.directory = directory;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathFor(key), "utf8");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(resolve(this.directory), { recursive: true });
    await writeFile(path, value, "utf8");
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathFor(key));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(resolve(this.directory));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return entries.filter((name) => name.endsWith(EXTENSION)).map((name) => name.slice(0, -EXTENSION.length));
  }

  private pathFor(key: string): string {
    if (key.length === 0 || key.includes("/") || key.includes("\\")) {
      throw new Error(`FileStore: key "${key}" escapes the store directory`);
    }
    return resolve(this.directory, key + EXTENSION);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}
