// Live Dynamic test. Gated by LIVE_DYNAMIC=1 - never runs on the Windows host
// (the MPC native binary only ships for linux/darwin) and never in normal CI.
// Run inside Docker with real Dynamic credentials from the internal .env, e.g.:
//   docker compose run --rm -e LIVE_DYNAMIC=1 --env-file <internal>/.env \
//     -e WALLET_ENCRYPTION_KEY=<throwaway 32-byte hex> agents \
//     pnpm --filter @advance/agent-kit test:live
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, verifyTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLiveDynamicClient, DynamicKeys, type DynamicClient } from "../src/dynamic.js";
import { syncAllowlist } from "../src/policy.js";
import { FileStore } from "../src/store.js";

const LIVE = process.env.LIVE_DYNAMIC === "1";

describe.skipIf(!LIVE)("Dynamic live (LIVE_DYNAMIC=1)", () => {
  let dir: string;
  let client: DynamicClient;
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY ?? randomBytes(32).toString("hex");

  beforeAll(async () => {
    const environmentId = process.env.DYNAMIC_ENVIRONMENT_ID;
    const apiToken = process.env.DYNAMIC_API_TOKEN;
    if (!environmentId || !apiToken) {
      throw new Error("LIVE_DYNAMIC=1 requires DYNAMIC_ENVIRONMENT_ID and DYNAMIC_API_TOKEN in the environment");
    }
    dir = mkdtempSync(join(tmpdir(), "agent-kit-live-"));
    client = await createLiveDynamicClient({ environmentId, apiToken });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("creates a Dynamic MPC key, signs EIP-712 typed data, and verifies with viem", async () => {
    const store = new FileStore(dir);
    const keys = new DynamicKeys(client, store, encryptionKey);

    const label = `live-${Date.now()}`;
    const { address } = await keys.createKey(label);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log("[live] created key, address:", address);

    const domain = {
      name: "Advance agent-kit live test",
      version: "1",
      chainId: 84532,
      verifyingContract: getAddress(`0x${"0".repeat(38)}de`),
    } as const;
    const types = { Ping: [{ name: "nonce", type: "uint256" }] };
    const message = { nonce: BigInt(Date.now()) };

    const signature = await keys.signTypedData(label, {
      domain,
      types,
      primaryType: "Ping",
      message,
    });
    expect(signature).toMatch(/^0x[0-9a-fA-F]+$/);
    console.log("[live] signTypedData ok, signature length:", signature.length);

    const verified = await verifyTypedData({
      address: getAddress(address),
      domain,
      types,
      primaryType: "Ping",
      message,
      signature,
    });
    expect(verified).toBe(true);
    console.log("[live] viem verifyTypedData ->", verified);
  });

  it("syncs the Base Sepolia tx allowlist and gets a 201", async () => {
    const dummyAddresses = [
      "0x0000000000000000000000000000000000A1a1",
      "0x0000000000000000000000000000000000A2a2",
    ];
    const result = await syncAllowlist({
      chainIds: [84532],
      addresses: dummyAddresses,
      name: `advance-test-allowlist-${Date.now()}`,
    });
    console.log("[live] syncAllowlist status:", result.status);
    expect(result.status).toBe(201);
  });
});
