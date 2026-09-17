/**
 * Minimal ABI for the Doppler `FeesManager` (as deployed in `DopplerHookInitializer`).
 * Base: `0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544` (Bankr default launches; verified on Sourcify).
 * `PoolId` is `bytes32` at the ABI level (Uniswap v4 `PoolId = keccak256(abi.encode(PoolKey))`).
 */
export const feesManagerAbi = [
  {
    type: "function",
    name: "getCumulatedFees0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getCumulatedFees1",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getShares",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPoolKey",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
  {
    type: "function",
    name: "collectFees",
    stateMutability: "nonpayable",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "fees0", type: "uint128" },
      { name: "fees1", type: "uint128" },
    ],
  },
  /**
   * `DopplerHookInitializer`'s auto-generated getter for `mapping(address asset => PoolState
   * state) public getState` (struct fields `beneficiaries`/`adjustedCurves` are dynamic
   * arrays, which Solidity's default struct getter omits; every other field is returned in
   * declaration order). Compiled and cross-checked live against the real deployment
   * (`0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544`, verified present on both Base mainnet and
   * Base Sepolia).
   */
  {
    type: "function",
    name: "getState",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "numeraire", type: "address" },
      { name: "totalTokensOnBondingCurve", type: "uint256" },
      { name: "dopplerHook", type: "address" },
      { name: "graduationDopplerHookCalldata", type: "bytes" },
      { name: "status", type: "uint8" },
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "farTick", type: "int24" },
    ],
  },
  /**
   * Non-zero iff `dopplerHook` is registered for the given callback flags (see
   * `ON_GRADUATION_FLAG = 1 << 2` etc. in `BaseDopplerHook.sol`). A pool whose hook has
   * `ON_GRADUATION_FLAG` set can trigger `onGraduation` — graduation permanently disables
   * fee collection for the escrow, so this gates pool eligibility alongside `PoolStatus`.
   */
  {
    type: "function",
    name: "isDopplerHookEnabled",
    stateMutability: "view",
    inputs: [{ name: "dopplerHook", type: "address" }],
    outputs: [{ name: "flags", type: "uint256" }],
  },
  /**
   * Reverted by `DopplerHookInitializer.collectFees` when the underlying asset's
   * `PoolStatus` isn't `Locked` yet (e.g. a block before the pool was locked, or a pool
   * still mid-migration). `getCumulatedFees{0,1}` are plain mapping reads and never
   * revert this way — only the `collectFees` simulation can hit this.
   */
  {
    type: "error",
    name: "WrongPoolStatus",
    inputs: [
      { name: "expected", type: "uint8" },
      { name: "actual", type: "uint8" },
    ],
  },
  /** `MiniV4Manager`'s immutable Uniswap v4 `PoolManager` — read directly rather than
   * trusted from docs, so the per-chain address in `chains.ts` is verifiable on-chain. */
  {
    type: "function",
    name: "poolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * `DopplerHookInitializer`'s `Lock` event, emitted once when a pool locks, carrying the
 * full beneficiary list (including the majority "creator" share) that `getState`'s
 * auto-generated getter can't return (it's a dynamic array field). Signature verified
 * live: `cast sig-event "Lock(address,(address,uint96)[])"` matches the real emitted
 * topic0. The indexed param is the asset/token address despite the source comment
 * calling it "pool". Kept as its own single-element array (like
 * `poolManagerSwapEventAbi`) so it can be indexed as `feesManagerLockEventAbi[0]` for
 * `getLogs`'s `event` argument.
 */
export const feesManagerLockEventAbi = [
  {
    type: "event",
    name: "Lock",
    inputs: [
      { name: "asset", type: "address", indexed: true },
      {
        name: "beneficiaries",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "beneficiary", type: "address" },
          { name: "shares", type: "uint96" },
        ],
      },
    ],
  },
] as const;
