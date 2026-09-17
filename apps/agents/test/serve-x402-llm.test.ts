import { afterEach, describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { loadConfig } from "../src/config.js";
import { startServer, type RunningServer } from "../src/bin/serve-x402-llm.js";

/** Facilitator double: never touches the network, only ever needs to answer `getSupported`. */
const offlineFacilitatorClient: FacilitatorClient = {
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    };
  },
  async verify(): Promise<never> {
    throw new Error("not reached: this test never pays");
  },
  async settle(): Promise<never> {
    throw new Error("not reached: this test never pays");
  },
};

describe("serve-x402-llm bootstrap", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("listens on a real ephemeral TCP port and returns 402 for an unpaid request", async () => {
    const config = loadConfig({
      LLM_BASE_URL: "https://example.invalid",
      SERVICE_PAYTO: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
      CHAIN_ID: "84532",
    });

    running = await startServer(config, { port: 0, facilitatorClient: offlineFacilitatorClient });
    expect(running.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${running.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("stops accepting connections after close()", async () => {
    const config = loadConfig({
      LLM_BASE_URL: "https://example.invalid",
      SERVICE_PAYTO: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
      CHAIN_ID: "84532",
    });
    const server = await startServer(config, { port: 0, facilitatorClient: offlineFacilitatorClient });
    const { port } = server;
    await server.close();
    running = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/v1/data/x`)).rejects.toBeTruthy();
  });
});
