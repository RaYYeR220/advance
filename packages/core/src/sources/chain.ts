import { BASE_RPC_URL_DEFAULT } from "../chains.js";
import { createLiveChainOps } from "./chainOps.js";
import { createFixtureChainOps, type ChainFixture } from "./chainFixture.js";
import { buildChainReader, type ChainReader } from "./chainLogic.js";

export type {
  ChainReader,
  PoolKeyInfo,
  FeeAccrual,
  SwapRecord,
  CreatorRevenueWindow,
  EthUsdPrice,
  TokenCreatedAt,
  AssetState,
} from "./chainLogic.js";
export {
  BlockAtBeforeGenesisError,
  isPoolEligibleForEscrow,
  computePoolId,
  pickMajorityBeneficiary,
  POOL_STATUS_LOCKED,
  ZERO_ADDRESS,
} from "./chainLogic.js";
export type { ChainFixture, RawSwapLogJson } from "./chainFixture.js";
export { FixtureMissError, createFixtureChainOps } from "./chainFixture.js";
export {
  createLiveChainOps,
  isPreLockWrongPoolStatus,
  ZERO_SHARE_ADDRESS,
  type ChainOps,
  type RawSwapLog,
  type AssetStateRaw,
  type LockBeneficiary,
  type AirlockAssetData,
} from "./chainOps.js";
export { createRecordingChainOps } from "./chainFixture.js";

/** Live archive chain reader. Defaults to `BASE_RPC_URL_DEFAULT` (never publicnode). */
export function createChainReader(
  rpcUrl: string = BASE_RPC_URL_DEFAULT,
): ChainReader {
  return buildChainReader(createLiveChainOps(rpcUrl));
}

/** Fixture-backed chain reader — never hits the network; unit tests use this exclusively. */
export function createFixtureChainReader(fixture: ChainFixture): ChainReader {
  return buildChainReader(createFixtureChainOps(fixture));
}
