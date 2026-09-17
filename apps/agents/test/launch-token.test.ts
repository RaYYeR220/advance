import { describe, expect, it, vi } from "vitest";
import {
  BANKR_DEPLOY_URL,
  buildBankrLaunchRequest,
  buildDopplerLaunchPlan,
  redactRequestForPrint,
  runLaunchToken,
  DOPPLER_SEPOLIA_ADDRESSES,
} from "../src/bin/launch-token.js";

const TREASURY = "0x00000000000000000000000000000000t0001".replace("t", "1") as `0x${string}`;
const PROTOCOL_OWNER = "0x00000000000000000000000000000000000005" as `0x${string}`;

describe("buildBankrLaunchRequest", () => {
  it("builds the exact documented endpoint, method, and body shape", () => {
    const req = buildBankrLaunchRequest(
      { tokenName: "My Token", tokenSymbol: "MTK", feeRecipient: TREASURY },
      "bk_secret_value",
    );
    expect(req.method).toBe("POST");
    expect(req.url).toBe(BANKR_DEPLOY_URL);
    expect(req.url).toBe("https://api.bankr.bot/token-launches/deploy");
    expect(req.headers["X-API-Key"]).toBe("bk_secret_value");
    expect(req.body).toEqual({
      tokenName: "My Token",
      tokenSymbol: "MTK",
      chain: "base",
      feeRecipient: { type: "wallet", value: TREASURY },
    });
  });

  it("includes optional launch flags only when explicitly provided", () => {
    const req = buildBankrLaunchRequest(
      {
        tokenName: "My Token",
        tokenSymbol: "MTK",
        feeRecipient: TREASURY,
        disableVesting: true,
        quoteOnlyFees: true,
        degenMode: false,
      },
      "bk_secret_value",
    );
    expect(req.body).toMatchObject({
      disableVesting: true,
      quoteOnlyFees: true,
      degenMode: false,
    });
  });
});

describe("redactRequestForPrint", () => {
  it("redacts the API key header but keeps the header name and the rest of the request intact", () => {
    const req = buildBankrLaunchRequest(
      { tokenName: "My Token", tokenSymbol: "MTK", feeRecipient: TREASURY },
      "bk_super_secret",
    );
    const printable = redactRequestForPrint(req);
    expect(printable.headers["X-API-Key"]).not.toBe("bk_super_secret");
    expect(printable.headers["X-API-Key"]).toMatch(/redacted/i);
    expect(JSON.stringify(printable)).not.toContain("bk_super_secret");
    expect(printable.url).toBe(req.url);
    expect(printable.body).toEqual(req.body);
  });
});

describe("buildDopplerLaunchPlan", () => {
  it("targets the confirmed Base Sepolia Airlock + DopplerHookInitializer and gives the fee recipient the majority beneficiary share", () => {
    const plan = buildDopplerLaunchPlan({
      tokenName: "My Token",
      tokenSymbol: "MTK",
      feeRecipient: TREASURY,
      protocolOwner: PROTOCOL_OWNER,
    });
    expect(plan.chainId).toBe(84532);
    expect(plan.airlock).toBe(DOPPLER_SEPOLIA_ADDRESSES.airlock);
    expect(plan.hookInitializer).toBe(DOPPLER_SEPOLIA_ADDRESSES.dopplerHookInitializer);
    expect(plan.migration).toBe("noOp");
    const total = plan.beneficiaries.reduce((sum, b) => sum + b.shares, 0n);
    expect(total).toBe(10n ** 18n);
    const feeRecipientShare = plan.beneficiaries.find((b) => b.beneficiary === TREASURY);
    const protocolShare = plan.beneficiaries.find((b) => b.beneficiary === PROTOCOL_OWNER);
    expect(feeRecipientShare).toBeDefined();
    expect(protocolShare).toBeDefined();
    expect(feeRecipientShare!.shares).toBeGreaterThan(protocolShare!.shares);
    expect(protocolShare!.shares).toBeGreaterThanOrEqual((10n ** 18n * 5n) / 100n);
  });
});

describe("runLaunchToken", () => {
  it("defaults to dry-run and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    const result = await runLaunchToken(
      { chain: "base", name: "My Token", symbol: "MTK", feeRecipient: TREASURY, execute: false },
      { bankrApiKey: "bk_secret", fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(result.executed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun && "request" in result.dryRun ? result.dryRun.request.url : undefined).toBe(
      BANKR_DEPLOY_URL,
    );
  });

  it("refuses --execute against Base mainnet even when explicitly requested", async () => {
    const fetchSpy = vi.fn();
    await expect(
      runLaunchToken(
        { chain: "base", name: "My Token", symbol: "MTK", feeRecipient: TREASURY, execute: true },
        { bankrApiKey: "bk_secret", fetchImpl: fetchSpy as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/mainnet/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
