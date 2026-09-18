import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A tiny resumable-step ledger for the seed script: `step(name, fn)` runs `fn` only if `name`
 * hasn't already recorded a result, persisting whatever JSON-serializable value `fn` resolves to
 * (bigints are stringified going in, restored coming back out via `bigintKeys`). Re-running the
 * whole script after a crash/interrupt skips every step already recorded and picks up exactly
 * where it left off.
 */
export class Checkpoint {
  private data: Record<string, unknown> = {};
  private loaded = false;

  constructor(private readonly path: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.data = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data, null, 2), "utf8");
  }

  async has(name: string): Promise<boolean> {
    await this.load();
    return name in this.data;
  }

  async get<T>(name: string): Promise<T | undefined> {
    await this.load();
    return this.data[name] as T | undefined;
  }

  /** Runs `fn` and records its result under `name`, unless `name` already has a recorded result
   * (in which case that stored result is returned and `fn` never runs again). */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.load();
    if (name in this.data) {
      console.log(`[skip] ${name} (already done)`);
      return this.data[name] as T;
    }
    console.log(`[run]  ${name}`);
    const result = await fn();
    this.data[name] = result;
    await this.save();
    console.log(`[done] ${name}`);
    return result;
  }
}
