// Zero-dependency fake underwriter API for e2e tests: serves deterministic score/evidence
// responses so `/underwrite/[token]` can be exercised end to end without a live chain or a
// real underwriter deployment. Wire format matches `apps/underwriter`'s real routes closely
// enough for `@advance/sdk`'s `reviveBigints` to parse it: every bigint field is a decimal
// string, every plain number field is a JSON number.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4311);

// Mirrors the constants duplicated in `e2e/underwrite.spec.ts`.
const ELIGIBLE_TOKEN = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const DENY_TOKEN = "0xdededededededededededededededededededede";
const ERROR_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ELIGIBLE_HASH = `0x${"ab".repeat(32)}`;
const DENY_HASH = `0x${"cd".repeat(32)}`;
const CHAIN_ID = 84532;

function baseEvidence(token, overrides) {
  return {
    engineVersion: "advance-core-underwriting-1",
    chainId: CHAIN_ID,
    token,
    feesManager: "0x3333333333333333333333333333333333333333",
    poolId: `0x${"11".repeat(32)}`,
    rawReads: [],
    swapSample: {
      fromBlock: "18000000",
      toBlock: "18010000",
      cap: 400,
      stats: overrides.stats,
    },
    formula: {
      revenue: overrides.revenue,
      quality: overrides.quality,
      computedTerms: overrides.computedTerms,
    },
    rulesFired: overrides.rulesFired,
    finalTerms: overrides.computedTerms,
  };
}

const eligibleQuality = { swapCount: 42, top5ConcentrationRatio: 0.35, washRatio: 0.05, cv: 0.6, haircutBps: 7100 };
const eligibleRevenue = {
  revenueWei: { d1: "600000000000000", d7: "3000000000000000", d30: "10500000000000000" },
  revenueMicroUsd: { d1: "2000000", d7: "10000000", d30: "35000000" },
  ageSeconds: "1728000",
  creatorSharesWad: "950000000000000000",
  dailyRevenueWei: [
    "800000000000000",
    "900000000000000",
    "700000000000000",
    "1000000000000000",
    "850000000000000",
    "950000000000000",
    "900000000000000",
  ],
};
const eligibleTerms = {
  revenueWei: eligibleRevenue.revenueWei,
  revenueMicroUsd: eligibleRevenue.revenueMicroUsd,
  projected90dMicroUsd: "300000000",
  haircutBps: 7100,
  capMicroUsd: "55000000",
  floorCents: 85,
  minPrincipal: "23375000",
  drawLimit: "1669642",
  drawPeriod: 86400,
  gracePeriod: 1209600,
  noteSupply: "55000000000000000000",
  auctionBlocks: "1000",
};

const eligibleEvidence = baseEvidence(ELIGIBLE_TOKEN, {
  stats: { swapCount: 42, top5ConcentrationRatio: 0.35, washRatio: 0.05, cv: 0.6 },
  revenue: eligibleRevenue,
  quality: eligibleQuality,
  computedTerms: eligibleTerms,
  rulesFired: [],
});

const denyQuality = { swapCount: 12, top5ConcentrationRatio: 0.85, washRatio: 0.1, cv: undefined, haircutBps: 2000 };
const denyRevenue = {
  revenueWei: { d1: "50000000000000", d7: "200000000000000", d30: "600000000000000" },
  revenueMicroUsd: { d1: "500000", d7: "2000000", d30: "6000000" },
  ageSeconds: "100000",
  creatorSharesWad: "950000000000000000",
  dailyRevenueWei: ["10000000000000", "20000000000000", "30000000000000", "15000000000000", "25000000000000", "20000000000000", "18000000000000"],
};
const denyTerms = {
  revenueWei: denyRevenue.revenueWei,
  revenueMicroUsd: denyRevenue.revenueMicroUsd,
  projected90dMicroUsd: "8000000",
  haircutBps: 2000,
  capMicroUsd: "800000",
  floorCents: 90,
  minPrincipal: "360000",
  drawLimit: "100000",
  drawPeriod: 86400,
  gracePeriod: 1209600,
  noteSupply: "800000000000000000",
  auctionBlocks: "1000",
};

const denyEvidence = baseEvidence(DENY_TOKEN, {
  stats: { swapCount: 12, top5ConcentrationRatio: 0.85, washRatio: 0.1, cv: undefined },
  revenue: denyRevenue,
  quality: denyQuality,
  computedTerms: denyTerms,
  rulesFired: ["too_young", "concentrated_flow"],
});

const EVIDENCE_BY_HASH = new Map([
  [ELIGIBLE_HASH, eligibleEvidence],
  [DENY_HASH, denyEvidence],
]);

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (parts[0] === "v1" && parts[1] === "score" && parts.length === 3) {
    const token = parts[2].toLowerCase();
    if (token === ELIGIBLE_TOKEN) {
      json(res, 200, { kind: "eligible", token: ELIGIBLE_TOKEN, terms: eligibleTerms, evidenceHash: ELIGIBLE_HASH, evidence: eligibleEvidence });
      return;
    }
    if (token === DENY_TOKEN) {
      json(res, 200, { kind: "deny", token: DENY_TOKEN, reasons: ["too_young", "concentrated_flow"], evidenceHash: DENY_HASH, evidence: denyEvidence });
      return;
    }
    if (token === ERROR_TOKEN) {
      json(res, 500, { error: "underwriter internal error" });
      return;
    }
    // Any other well-formed address: the realistic default — not a token Advance has ever seen.
    json(res, 200, {
      kind: "deny",
      token,
      reasons: ["not_bankr_doppler"],
      evidenceHash: DENY_HASH,
      evidence: baseEvidence(token, {
        stats: { swapCount: 0, top5ConcentrationRatio: 0, washRatio: 0, cv: undefined },
        revenue: { revenueWei: { d1: "0", d7: "0", d30: "0" }, revenueMicroUsd: { d1: "0", d7: "0", d30: "0" }, ageSeconds: "0", creatorSharesWad: "0", dailyRevenueWei: [] },
        quality: { swapCount: 0, top5ConcentrationRatio: 0, washRatio: 0, cv: undefined, haircutBps: 0 },
        computedTerms: { ...denyTerms, capMicroUsd: "0", minPrincipal: "0", drawLimit: "100000" },
        rulesFired: ["not_bankr_doppler"],
      }),
    });
    return;
  }

  if (parts[0] === "v1" && parts[1] === "evidence" && parts.length === 3) {
    const hash = parts[2].toLowerCase();
    const bundle = EVIDENCE_BY_HASH.get(hash);
    if (!bundle) {
      json(res, 404, { error: "evidence not found" });
      return;
    }
    json(res, 200, bundle);
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`fake underwriter listening on ${PORT}`);
});
