import { BASE_MAINNET } from "@/lib/explorer";
import type { LandingData } from "@/lib/landing-data";

/**
 * A fully-populated `LandingData` sample, used only by tests that need realistic figures for
 * a component (`charts.test.ts`, `portrait.test.ts`) — the landing page itself reads live data
 * via `getLandingDataSafe()` (`lib/data.ts`), never this fixture.
 */
export const landingFixture: LandingData = {
  chainId: BASE_MAINNET,
  issue: { number: "03", date: "September 2026" },
  hero: {
    agent: "0x3f2c7ff8a130f2c8681543876d0556d98c7b9e11",
    loansRepaid: 3,
    defaults: 0,
    weeklyFeesUsd: 96,
    note: {
      agentLabel: "0x3f2c",
      series: "0x3f2c",
      notesOutstanding: 372,
      repaidPerNote: 1,
      clearingPriceCents: 84,
      capMultiple: 1.19,
      borrowedUsd: 312,
      repaidUsd: 241.8,
      capUsd: 372,
      sweeps: [
        6.2, 8.1, 7.4, 9.9, 11.2, 8.6, 10.4, 12.8, 9.1, 11.7, 13.4, 10.9, 12.2, 9.8, 11.5, 12.6, 10.3, 11.9, 9.4,
        12.7, 10.8, 8.1, 11.4,
      ],
      latestBlock: 18_204_090,
    },
  },
  lifecycle: {
    score: 71,
    floorCents: 80,
    clearingPriceCents: 84,
    dailyLimitUsd: 40,
    blockedDrawUsd: 900,
  },
  refusal: {
    block: 18_204_113,
    agent: "0x9b0738bbf6848b18ef40369ab5c925cdf96041d0",
    payee: "0x7a1f40c9d2b35e8a6f71c04b9d2e58a3f61be2c3",
    promptedUsdc: 500,
    receipt: {
      tx: "0x5e1d8c42b7a09f36e15d2c84a7b90e3f61d5c28a4b7e09f3d6c15a28b4e7a94c",
      creditLine: "0x2c88d41e7a3b95c20f6e8d17a4b39c05e2d7f301",
      drawUsdc: 900,
      dailyLimitUsdc: 40,
      drawnTodayUsdc: 40,
      error: "DrawLimitExceeded",
      gasUsed: 31_204,
    },
    tally: {
      refusals: 37,
      unauthorizedTransfers: 0,
      revertedDraws: 9,
      refusedPayments: 28,
      fundedAgents: 12,
    },
  },
  audiences: {
    token: "0x3f2c7ff8a130f2c8681543876d0556d98c7b9e11",
    quote: { score: 71, maxUsd: 312, dailyLimitUsd: 40, notes: 372 },
    memo: { largestPoolSharePct: 30, formulaLimitUsd: 55 },
    auction: {
      startBlock: 18_196_360,
      blocks: 40,
      floorCents: 80,
      steps: [
        { fromBlock: 0, priceCents: 80 },
        { fromBlock: 8, priceCents: 81 },
        { fromBlock: 15, priceCents: 82 },
        { fromBlock: 22, priceCents: 83 },
        { fromBlock: 30, priceCents: 84 },
      ],
      bid: { maxPriceCents: 86, atBlock: 12, budgetUsdc: 120, filledNotes: 142, claimableUsd: 92.3 },
    },
  },
  economy: {
    fundedAgents: 12,
    repaidUsd: 4180,
    refusals: 37,
    weeklyRepaidUsd: [40, 95, 160, 210, 260, 300, 340, 380, 420, 560, 640, 775],
    block: 18_204_113,
  },
  builtOn: {
    contracts: [
      { name: "AdvanceHub", role: "term sheets, loans, defaults" },
      { name: "RevenueEscrow", role: "holds fee rights, runs sweeps" },
      { name: "RevenueNote", role: "one token per $1 of repayment" },
      { name: "CreditLine", role: "daily draw limit, card only" },
    ],
    rails: [
      {
        name: "Bankr",
        role: "Token launches and the trading fees that back every loan.",
        detail: "Also the LLM gateway agents pay from their cards.",
      },
      {
        name: "Uniswap",
        role: "Continuous clearing auctions price each note.",
        detail: "Pools convert swept fees to USDC.",
      },
      {
        name: "Dynamic",
        role: "Server wallets for each agent's treasury and card.",
        detail: "Signing policies refuse payees off the allowlist.",
      },
      { name: "Base", role: "Where every loan, draw, sweep and refusal settles.", detail: "Chain 8453." },
      {
        name: "ERC-8004",
        role: "Agent identity and reputation registries.",
        detail: "Repayments and defaults are posted here.",
      },
    ],
  },
};
