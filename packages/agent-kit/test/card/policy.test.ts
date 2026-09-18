import { describe, expect, it } from "vitest";
import { precheck, type CardPolicyConfig, type PaymentRequirementLike } from "../../src/card/policy.js";

const PAYEE = "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0";
const OTHER_PAYEE = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EVIL = "0x000000000000000000000000000000000000dEaD";

function baseCard(overrides: Partial<CardPolicyConfig> = {}): CardPolicyConfig {
  return {
    network: "eip155:8453",
    usdc: USDC,
    payees: [PAYEE, OTHER_PAYEE],
    perCallCap: 10_000n,
    maxAuthWindow: 300n,
    usdcBalance: 1_000_000n,
    frozen: false,
    ...overrides,
  };
}

function baseReq(overrides: Partial<PaymentRequirementLike> = {}): PaymentRequirementLike {
  return {
    network: "eip155:8453",
    asset: USDC,
    payTo: PAYEE,
    amount: "1000",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

describe("precheck", () => {
  it("passes a requirement that satisfies every rule", () => {
    expect(precheck(baseReq(), baseCard())).toEqual({ ok: true });
  });

  it("refuses when the card is frozen, before any other check", () => {
    // network is also wrong here - frozen must still win, since a frozen card
    // can never pay regardless of any other field.
    const req = baseReq({ network: "eip155:84532" });
    expect(precheck(req, baseCard({ frozen: true }))).toEqual({ ok: false, reason: "card_frozen" });
  });

  it("passes with case-different but same-value addresses (asset, payTo)", () => {
    const req = baseReq({ asset: USDC.toUpperCase().replace("0X", "0x"), payTo: PAYEE.toLowerCase() });
    expect(precheck(req, baseCard())).toEqual({ ok: true });
  });

  it("refuses when the requirement's network doesn't match the card's chain", () => {
    const req = baseReq({ network: "eip155:84532" });
    expect(precheck(req, baseCard())).toEqual({ ok: false, reason: "network_mismatch" });
  });

  it("refuses when the requirement's asset isn't the card's USDC", () => {
    const req = baseReq({ asset: EVIL });
    expect(precheck(req, baseCard())).toEqual({ ok: false, reason: "asset_mismatch" });
  });

  it("refuses when payTo is not in the card's payee allowlist", () => {
    const req = baseReq({ payTo: EVIL });
    expect(precheck(req, baseCard())).toEqual({ ok: false, reason: "payee_not_allowlisted" });
  });

  it("refuses when payTo is not allowlisted even if it happens to equal the card's USDC address", () => {
    const req = baseReq({ payTo: USDC });
    expect(precheck(req, baseCard())).toEqual({ ok: false, reason: "payee_not_allowlisted" });
  });

  it("passes at exactly the per-call cap", () => {
    const req = baseReq({ amount: "10000" });
    expect(precheck(req, baseCard({ perCallCap: 10_000n }))).toEqual({ ok: true });
  });

  it("refuses one atomic unit over the per-call cap", () => {
    const req = baseReq({ amount: "10001" });
    expect(precheck(req, baseCard({ perCallCap: 10_000n }))).toEqual({
      ok: false,
      reason: "amount_exceeds_per_call_cap",
    });
  });

  it("passes at exactly the max auth window", () => {
    const req = baseReq({ maxTimeoutSeconds: 300 });
    expect(precheck(req, baseCard({ maxAuthWindow: 300n }))).toEqual({ ok: true });
  });

  it("refuses one second over the max auth window", () => {
    const req = baseReq({ maxTimeoutSeconds: 301 });
    expect(precheck(req, baseCard({ maxAuthWindow: 300n }))).toEqual({
      ok: false,
      reason: "timeout_exceeds_auth_window",
    });
  });

  it("passes when the amount exactly equals the card's USDC balance", () => {
    const req = baseReq({ amount: "1000" });
    expect(precheck(req, baseCard({ usdcBalance: 1000n }))).toEqual({ ok: true });
  });

  it("refuses when the amount exceeds the card's USDC balance", () => {
    const req = baseReq({ amount: "1000" });
    expect(precheck(req, baseCard({ usdcBalance: 999n }))).toEqual({
      ok: false,
      reason: "amount_exceeds_card_balance",
    });
  });

  it("refuses a non-numeric amount string", () => {
    const req = baseReq({ amount: "not-a-number" });
    expect(precheck(req, baseCard())).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("refuses a negative amount string", () => {
    const req = baseReq({ amount: "-1" });
    expect(precheck(req, baseCard())).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("refuses against an empty payee list (defense in depth; the contract itself never allows this)", () => {
    expect(precheck(baseReq(), baseCard({ payees: [] }))).toEqual({ ok: false, reason: "payee_not_allowlisted" });
  });

  it("never mutates its inputs", () => {
    const req = baseReq();
    const card = baseCard();
    const reqCopy = { ...req };
    const cardCopy = { ...card, payees: [...card.payees] };
    precheck(req, card);
    expect(req).toEqual(reqCopy);
    expect(card).toEqual(cardCopy);
  });
});
