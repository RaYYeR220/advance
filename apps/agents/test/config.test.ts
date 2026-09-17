import { describe, expect, it } from "vitest";
import { loadConfig, usdcAddressForChain, usdcEip712DomainForChain } from "../src/config.js";

const validEnv = {
  LLM_BASE_URL: "https://api.venice.ai/api/v1",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  SERVICE_PAYTO: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
  CHAIN_ID: "84532",
};

describe("loadConfig", () => {
  it("parses a minimal valid env, defaulting the facilitator URL and REDTEAM off", () => {
    const cfg = loadConfig({
      LLM_BASE_URL: validEnv.LLM_BASE_URL,
      SERVICE_PAYTO: validEnv.SERVICE_PAYTO,
      CHAIN_ID: validEnv.CHAIN_ID,
    });
    expect(cfg.LLM_BASE_URL).toBe(validEnv.LLM_BASE_URL);
    expect(cfg.X402_FACILITATOR_URL).toBe("https://x402.org/facilitator");
    expect(cfg.CHAIN_ID).toBe(84532);
    expect(cfg.LLM_API_KEY).toBeUndefined();
    expect(cfg.REDTEAM).toBe(false);
    expect(cfg.ALLOW_MAINNET_SERVICE).toBe(false);
  });

  it("accepts an explicit facilitator URL, API key, and REDTEAM=1", () => {
    const cfg = loadConfig({ ...validEnv, LLM_API_KEY: "sk-test", REDTEAM: "1" });
    expect(cfg.X402_FACILITATOR_URL).toBe(validEnv.X402_FACILITATOR_URL);
    expect(cfg.LLM_API_KEY).toBe("sk-test");
    expect(cfg.REDTEAM).toBe(true);
  });

  it("accepts ALLOW_MAINNET_SERVICE=1", () => {
    const cfg = loadConfig({ ...validEnv, ALLOW_MAINNET_SERVICE: "1" });
    expect(cfg.ALLOW_MAINNET_SERVICE).toBe(true);
  });

  it("rejects a malformed SERVICE_PAYTO address", () => {
    expect(() => loadConfig({ ...validEnv, SERVICE_PAYTO: "not-an-address" })).toThrow();
  });

  it("rejects a missing LLM_BASE_URL", () => {
    const { LLM_BASE_URL, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow();
  });

  it("rejects a non-numeric CHAIN_ID", () => {
    expect(() => loadConfig({ ...validEnv, CHAIN_ID: "base-sepolia" })).toThrow();
  });
});

describe("usdcAddressForChain", () => {
  it("resolves the known Base Sepolia USDC address", () => {
    expect(usdcAddressForChain(84532)).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("resolves the known Base mainnet USDC address", () => {
    expect(usdcAddressForChain(8453)).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("fails closed for an unknown chain id", () => {
    expect(() => usdcAddressForChain(1)).toThrow();
  });
});

describe("usdcEip712DomainForChain", () => {
  it("resolves the on-chain EIP-712 domain for Base Sepolia USDC", () => {
    expect(usdcEip712DomainForChain(84532)).toEqual({ name: "USDC", version: "2" });
  });

  it("resolves the on-chain EIP-712 domain for Base mainnet USDC", () => {
    expect(usdcEip712DomainForChain(8453)).toEqual({ name: "USD Coin", version: "2" });
  });

  it("fails closed for an unknown chain id", () => {
    expect(() => usdcEip712DomainForChain(1)).toThrow();
  });
});
