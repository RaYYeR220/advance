/**
 * Minimal ABI for the Doppler `Airlock` contract — the on-chain discovery source (the
 * chain-native equivalent of Bankr's `token-fees` API). Verified live on both chains:
 * `getModuleState(dopplerFeesManager) == PoolInitializer (3)` and a real `getAssetData`
 * lookup against a known token (Ratspeak on Base mainnet, the Sepolia test launch on Base
 * Sepolia) using known real tokens (Ratspeak on mainnet, the Sepolia test launch).
 */
export const airlockAbi = [
  /**
   * Auto-generated getter for `mapping(address asset => AssetData data) public
   * getAssetData`. `AssetData` has no array/mapping members, so every field is returned in
   * declaration order — nothing is skipped the way `DopplerHookInitializer.getState` skips
   * its array fields.
   */
  {
    type: "function",
    name: "getAssetData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "numeraire", type: "address" },
      { name: "timelock", type: "address" },
      { name: "governance", type: "address" },
      { name: "liquidityMigrator", type: "address" },
      { name: "poolInitializer", type: "address" },
      { name: "pool", type: "address" },
      { name: "migrationPool", type: "address" },
      { name: "numTokensToSell", type: "uint256" },
      { name: "totalSupply", type: "uint256" },
      { name: "integrator", type: "address" },
    ],
  },
  {
    type: "function",
    name: "getModuleState",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
