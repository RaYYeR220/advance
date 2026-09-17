import type { Address, Hex } from "viem";
import { BankrTokenNotFoundError, pickBankrToken, type BankrClient } from "./bankr.js";
import { pickMajorityBeneficiary, ZERO_ADDRESS, type ChainReader } from "./chainLogic.js";

/** Thrown by a `DiscoverySource` when it has no pool for `token` at all — distinct from
 * any other failure (network error, malformed data), which must propagate so the engine
 * fails closed with `data_unavailable` rather than treating a real outage as "not found". */
export class DiscoveryNotFoundError extends Error {
  readonly source: "bankr" | "airlock";
  readonly token: Address;

  constructor(source: "bankr" | "airlock", token: Address) {
    super(`${source} discovery: no pool found for token ${token}`);
    this.name = "DiscoveryNotFoundError";
    this.source = source;
    this.token = token;
  }
}

export interface DiscoveryResult {
  source: "bankr" | "airlock";
  feesManager: Address;
  /** Claimed poolId — verified separately against the on-chain `keccak256(abi.encode(poolKey))`
   * before being trusted (see `engine.ts`'s binding check). */
  poolId: Hex;
  numeraire: Address;
  /** The party whose shares/revenue this decision tracks — Bankr's `address` field, or
   * (Airlock) the `Lock` event's majority (>50%) beneficiary. `ZERO_ADDRESS` if none could
   * be determined, which the existing `creator_has_no_shares` rule then denies. */
  creator: Address;
  tokenName: string;
  tokenSymbol: string;
}

export interface DiscoverySource {
  discover(token: Address): Promise<DiscoveryResult>;
}

/** Bankr's `token-fees` API — Base mainnet only (the API has no Sepolia data). */
export function createBankrDiscoverySource(bankr: BankrClient): DiscoverySource {
  return {
    async discover(token) {
      let response;
      try {
        response = await bankr.getTokenFees(token);
      } catch (err) {
        if (err instanceof BankrTokenNotFoundError) {
          throw new DiscoveryNotFoundError("bankr", token);
        }
        throw err;
      }

      let entry;
      try {
        entry = pickBankrToken(response, token);
      } catch (err) {
        if (err instanceof BankrTokenNotFoundError) {
          throw new DiscoveryNotFoundError("bankr", token);
        }
        throw err;
      }

      return {
        source: "bankr",
        feesManager: entry.initializer,
        poolId: entry.poolId,
        numeraire: entry.numeraire,
        creator: response.address,
        tokenName: entry.name,
        tokenSymbol: entry.symbol,
      };
    },
  };
}

/**
 * The on-chain equivalent of Bankr: `Airlock.getAssetData` for the pool initializer and
 * numeraire, `DopplerHookInitializer.getState` for the true poolKey/poolId, and the
 * `Lock` event's beneficiary list for the creator — no off-chain dependency at all, so
 * this is the only discovery source available off Base mainnet (e.g. Base Sepolia).
 *
 * `knownFeesManager` is the chain's own Doppler `FeesManager` constant
 * (`chainAddresses(chainId).dopplerFeesManager`) — `getAssetData`'s `poolInitializer` is
 * rejected as not-found immediately when it isn't that address, before any further call
 * (`getState`, the `Lock` log query), the same way an unknown `poolInitializer` is treated
 * as "no real Doppler pool" everywhere else in the engine.
 */
export function createAirlockDiscoverySource(
  reader: ChainReader,
  airlock: Address,
  knownFeesManager: Address,
): DiscoverySource {
  return {
    async discover(token) {
      const assetData = await reader.getAirlockAssetData(airlock, token);
      if (
        assetData.poolInitializer.toLowerCase() === ZERO_ADDRESS ||
        assetData.poolInitializer.toLowerCase() !== knownFeesManager.toLowerCase()
      ) {
        throw new DiscoveryNotFoundError("airlock", token);
      }

      const assetState = await reader.getAssetState(assetData.poolInitializer, token);
      const beneficiaries = await reader.getLockBeneficiaries(
        assetData.poolInitializer,
        token,
      );
      // The `Lock` event's recorded shares are a snapshot at lock time — a later
      // `updateBeneficiary` call can move shares between the same beneficiaries without
      // emitting another `Lock`, so the majority pick must use each candidate's *current*
      // on-chain shares, not the event's own numbers.
      const currentShares = await Promise.all(
        beneficiaries.map((b) => reader.getShares(assetData.poolInitializer, assetState.poolId, b.beneficiary)),
      );
      const withCurrentShares = beneficiaries.map((b, i) => ({
        beneficiary: b.beneficiary,
        shares: currentShares[i]!,
      }));
      const creator = pickMajorityBeneficiary(withCurrentShares) ?? ZERO_ADDRESS;

      return {
        source: "airlock",
        feesManager: assetData.poolInitializer,
        poolId: assetState.poolId,
        numeraire: assetData.numeraire,
        creator,
        // Airlock's AssetData carries no name/symbol, and it's display-only (the memo
        // prompt's untrusted_token_metadata) — not load-bearing for any underwriting
        // number, so left empty rather than adding another ERC20 read for it.
        tokenName: "",
        tokenSymbol: "",
      };
    },
  };
}
