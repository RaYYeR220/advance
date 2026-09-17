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
 */
export function createAirlockDiscoverySource(
  reader: ChainReader,
  airlock: Address,
): DiscoverySource {
  return {
    async discover(token) {
      const assetData = await reader.getAirlockAssetData(airlock, token);
      if (assetData.poolInitializer.toLowerCase() === ZERO_ADDRESS) {
        throw new DiscoveryNotFoundError("airlock", token);
      }

      const assetState = await reader.getAssetState(assetData.poolInitializer, token);
      const beneficiaries = await reader.getLockBeneficiaries(
        assetData.poolInitializer,
        token,
      );
      const creator = pickMajorityBeneficiary(beneficiaries) ?? ZERO_ADDRESS;

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
