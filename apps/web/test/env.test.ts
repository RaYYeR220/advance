import { describe, expect, it } from "vitest";
import { getPublicClient, loadWebEnv, resetPublicClientCache } from "@/lib/env";

const HUB = "0x00000000000000000000000000000000000A11CE";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ADVANCE_HUB: HUB,
    UNDERWRITER_API_URL: "https://underwriter.example.com",
    ...overrides,
  };
}

describe("loadWebEnv", () => {
  it("defaults to Base Sepolia when NEXT_PUBLIC_CHAIN_ID is unset", () => {
    const env = loadWebEnv(baseEnv());
    expect(env.chainId).toBe(84532);
    expect(env.rpcUrl).toBe("https://sepolia.base.org");
  });

  it("selects mainnet RPC defaults for chain 8453", () => {
    const env = loadWebEnv(baseEnv({ NEXT_PUBLIC_CHAIN_ID: "8453" }));
    expect(env.chainId).toBe(8453);
    expect(env.rpcUrl).toBe("https://mainnet.base.org");
  });

  it("prefers explicit RPC URLs over the defaults, per chain", () => {
    const mainnet = loadWebEnv(
      baseEnv({ NEXT_PUBLIC_CHAIN_ID: "8453", BASE_RPC_URL: "https://custom-mainnet.example.com" }),
    );
    expect(mainnet.rpcUrl).toBe("https://custom-mainnet.example.com");

    const sepolia = loadWebEnv(baseEnv({ BASE_SEPOLIA_RPC_URL: "https://custom-sepolia.example.com" }));
    expect(sepolia.rpcUrl).toBe("https://custom-sepolia.example.com");
  });

  it("rejects an unsupported chain id", () => {
    expect(() => loadWebEnv(baseEnv({ NEXT_PUBLIC_CHAIN_ID: "1" }))).toThrow(/NEXT_PUBLIC_CHAIN_ID/);
  });

  it("requires a well-formed ADVANCE_HUB address", () => {
    expect(() => loadWebEnv(baseEnv({ ADVANCE_HUB: undefined }))).toThrow(/ADVANCE_HUB/);
    expect(() => loadWebEnv(baseEnv({ ADVANCE_HUB: "not-an-address" }))).toThrow(/ADVANCE_HUB/);
  });

  it("requires UNDERWRITER_API_URL", () => {
    expect(() => loadWebEnv(baseEnv({ UNDERWRITER_API_URL: undefined }))).toThrow(/UNDERWRITER_API_URL/);
  });

  it("strips a trailing slash from the underwriter API URL", () => {
    const env = loadWebEnv(baseEnv({ UNDERWRITER_API_URL: "https://underwriter.example.com/" }));
    expect(env.underwriterApiUrl).toBe("https://underwriter.example.com");
  });

  it("leaves EVENTS_URL and BLOB_READ_WRITE_TOKEN undefined when unset", () => {
    const env = loadWebEnv(baseEnv());
    expect(env.eventsUrl).toBeUndefined();
    expect(env.blobReadWriteToken).toBeUndefined();
  });

  it("passes through EVENTS_URL and BLOB_READ_WRITE_TOKEN when set", () => {
    const env = loadWebEnv(
      baseEnv({ EVENTS_URL: "https://events.example.com/feed.json", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" }),
    );
    expect(env.eventsUrl).toBe("https://events.example.com/feed.json");
    expect(env.blobReadWriteToken).toBe("vercel_blob_rw_x");
  });
});

describe("getPublicClient", () => {
  it("returns the same client instance for the same chain/rpc pair", () => {
    resetPublicClientCache();
    const a = getPublicClient({ chainId: 84532, rpcUrl: "https://sepolia.base.org" });
    const b = getPublicClient({ chainId: 84532, rpcUrl: "https://sepolia.base.org" });
    expect(a).toBe(b);
  });

  it("builds a fresh client when the chain or RPC URL changes", () => {
    resetPublicClientCache();
    const a = getPublicClient({ chainId: 84532, rpcUrl: "https://sepolia.base.org" });
    const b = getPublicClient({ chainId: 8453, rpcUrl: "https://mainnet.base.org" });
    expect(a).not.toBe(b);
    expect(a.chain?.id).toBe(84532);
    expect(b.chain?.id).toBe(8453);
  });
});
