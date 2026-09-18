import type { Address, Hex } from "viem";

/**
 * One token entry in a Bankr `token-fees` response.
 *
 * Shape typed exactly from a live response (`GET
 * https://api.bankr.bot/public/doppler/token-fees/:token`), recorded 2026-09-17
 * for Ratspeak (`0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3`). `claimable`/`claimed`
 * are human-readable decimal strings (not wei) and are for discovery/display only —
 * exact revenue always comes from the archive `ChainReader`, never from this API.
 */
export interface BankrTokenFeeEntry {
  tokenAddress: Address;
  name: string;
  symbol: string;
  /** Uniswap v4 `PoolId`. */
  poolId: Hex;
  /** Doppler fees manager for this pool (per-pool; passed straight into `TermSheet.feesManager`). */
  initializer: Address;
  /** e.g. `"95.00%"` — display only; exact shares come from `ChainReader.getShares`. */
  share: string;
  token0Label: string;
  token1Label: string;
  /** The pool's non-token leg (WETH for v1-supported pools, BNKR or other for denied pools). */
  numeraire: Address;
  tokenIsToken0: boolean;
  claimable: { token0: string; token1: string };
  claimed: { token0: string; token1: string; count: number };
  source: string;
  chain: string;
}

export interface BankrDailyEarning {
  date: string;
  weth: string;
}

/**
 * Full response of `GET /public/doppler/token-fees/:token`. Despite the path taking a
 * *token* address, the API actually resolves and returns the *creator's* aggregate view:
 * `address` is the creator/beneficiary address, `tokens` contains (in every observed
 * response) exactly the one queried token, and the earnings arrays/totals are the
 * creator's WETH-denominated earnings across their whole Bankr portfolio. There is no
 * `launchTime` field in the live response — the closest proxies are `lifetimeDays` and
 * the first non-zero entry of `allTimeDailyEarnings`.
 */
export interface BankrTokenFeesResponse {
  /** Creator/beneficiary address the API resolved the queried token to. */
  address: Address;
  chain: string;
  /** Window size (days) covered by `dailyEarnings`. */
  days: number;
  tokens: BankrTokenFeeEntry[];
  dailyEarnings: BankrDailyEarning[];
  allTimeDailyEarnings: BankrDailyEarning[];
  lifetimeEarnedWeth: string;
  lifetimeDays: number;
  lifetimeBestDay: BankrDailyEarning;
  totals: { claimableWeth: string; claimedWeth: string; claimCount: number };
}

export class BankrTokenNotFoundError extends Error {
  readonly token: Address;

  constructor(token: Address) {
    super(`bankr: no doppler token-fees data for token ${token}`);
    this.name = "BankrTokenNotFoundError";
    this.token = token;
  }
}

export interface BankrClient {
  getTokenFees(token: Address): Promise<BankrTokenFeesResponse>;
}

const BANKR_TOKEN_FEES_URL =
  "https://api.bankr.bot/public/doppler/token-fees";

function isErrorBody(body: unknown): body is { error: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  );
}

/** Live Bankr client. `fetchImpl` defaults to the global `fetch`; inject for tests/tooling. */
export function createBankrClient(
  fetchImpl: typeof fetch = fetch,
): BankrClient {
  return {
    async getTokenFees(token: Address): Promise<BankrTokenFeesResponse> {
      const res = await fetchImpl(`${BANKR_TOKEN_FEES_URL}/${token}`);
      if (res.status === 404) {
        throw new BankrTokenNotFoundError(token);
      }
      if (!res.ok) {
        throw new Error(
          `bankr: unexpected status ${res.status} for token ${token}`,
        );
      }
      const body: unknown = await res.json();
      if (isErrorBody(body)) {
        throw new BankrTokenNotFoundError(token);
      }
      const response = body as BankrTokenFeesResponse;
      if (!response.tokens || response.tokens.length === 0) {
        throw new BankrTokenNotFoundError(token);
      }
      return response;
    },
  };
}

/** Fixture-backed Bankr client: never hits the network, returns the recorded response verbatim. */
export function createFixtureBankrClient(
  fixture: BankrTokenFeesResponse,
): BankrClient {
  return {
    async getTokenFees(token: Address): Promise<BankrTokenFeesResponse> {
      pickBankrToken(fixture, token);
      return fixture;
    },
  };
}

/** Finds the entry for `token` inside a `token-fees` response (case-insensitive). */
export function pickBankrToken(
  response: BankrTokenFeesResponse,
  token: Address,
): BankrTokenFeeEntry {
  const match = response.tokens.find(
    (t) => t.tokenAddress.toLowerCase() === token.toLowerCase(),
  );
  if (!match) {
    throw new BankrTokenNotFoundError(token);
  }
  return match;
}
