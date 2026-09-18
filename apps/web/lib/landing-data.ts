export type Address = `0x${string}`;
export type TxHash = `0x${string}`;

export interface NoteTerms {
  /** Short agent name shown to readers, e.g. `0x3f2c`. */
  agentLabel: string;
  /** Note series name, e.g. `0x3f2c`. */
  series: string;
  notesOutstanding: number;
  /** USD repaid on each note once the cap is reached. */
  repaidPerNote: number;
  clearingPriceCents: number;
  capMultiple: number;
  borrowedUsd: number;
  repaidUsd: number;
  capUsd: number;
  /** USD swept to noteholders in each sweep, oldest first. */
  sweeps: readonly number[];
  latestBlock: number;
}

export interface AuctionStep {
  /** Block offset from the auction start at which this price takes effect. */
  fromBlock: number;
  priceCents: number;
}

export interface LandingData {
  chainId: number;
  issue: { number: string; date: string };
  hero: {
    agent: Address;
    loansRepaid: number;
    defaults: number;
    weeklyFeesUsd: number;
    note: NoteTerms;
  };
  lifecycle: {
    score: number;
    floorCents: number;
    clearingPriceCents: number;
    dailyLimitUsd: number;
    blockedDrawUsd: number;
  };
  refusal: {
    block: number;
    agent: Address;
    payee: Address;
    promptedUsdc: number;
    receipt: {
      tx: TxHash;
      creditLine: Address;
      drawUsdc: number;
      dailyLimitUsdc: number;
      drawnTodayUsdc: number;
      error: string;
      gasUsed: number;
    };
    tally: {
      refusals: number;
      unauthorizedTransfers: number;
      revertedDraws: number;
      refusedPayments: number;
      fundedAgents: number;
    };
  };
  audiences: {
    token: Address;
    quote: { score: number; maxUsd: number; dailyLimitUsd: number; notes: number };
    memo: { largestPoolSharePct: number; formulaLimitUsd: number };
    auction: {
      startBlock: number;
      blocks: number;
      floorCents: number;
      steps: readonly AuctionStep[];
      bid: { maxPriceCents: number; atBlock: number; budgetUsdc: number; filledNotes: number; claimableUsd: number };
    };
  };
  economy: {
    fundedAgents: number;
    repaidUsd: number;
    refusals: number;
    weeklyRepaidUsd: readonly number[];
    block: number;
  };
  builtOn: {
    contracts: readonly { name: string; role: string }[];
    rails: readonly { name: string; role: string; detail: string }[];
  };
}
