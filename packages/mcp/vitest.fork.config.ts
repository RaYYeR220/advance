import { defineConfig } from "vitest/config";

/**
 * Separate config for the anvil-fork write-tool suite: spawns `anvil`/`forge script` against a
 * real Base RPC (`BASE_RPC_URL`), so it's slow and network-dependent — kept out of the default
 * `pnpm test` run (see `vitest.config.ts`'s exclude) and run explicitly via `pnpm test:fork`.
 */
export default defineConfig({
  test: {
    include: ["test/fork/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
