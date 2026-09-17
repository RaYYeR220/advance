// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Uniswap v4 pool key, in the layout the PoolManager expects.
/// @dev Named apart from `IDopplerFeesManager`'s `PoolKey` so both can be used in one file.
struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Uniswap v4 swap parameters.
struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @notice The subset of the Uniswap v4 PoolManager this helper drives.
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(V4PoolKey memory key, V4SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @notice The ERC20 surface the settle/take legs need.
interface IPoolToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title V4Swapper
/// @notice Test-only exact-input swapper for Uniswap v4, used to push real volume through a
/// Doppler pool so its hook accrues real LP fees for the fees manager to release. Deliberately
/// minimal: no router, no Permit2, no slippage limits -- the caller approves this contract and
/// eats whatever price it gets, which is all a fee-generating fork test needs.
/// @dev Not part of the protocol; never deployed outside tests.
contract V4Swapper {
    /// @notice Uniswap v4 PoolManager on Base.
    IPoolManager public constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);

    /// @dev One tick above the minimum sqrt price, the limit for a zero-for-one swap.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739 + 1;
    /// @dev One tick below the maximum sqrt price, the limit for a one-for-zero swap.
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342 - 1;

    /// @dev A swap request carried through the PoolManager's unlock callback.
    struct Request {
        V4PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address trader;
    }

    /// @notice Thrown when the unlock callback is not made by the PoolManager.
    error NotPoolManager();

    /// @notice Swaps exactly `amountIn` of the pool's `zeroForOne ? currency0 : currency1` for the
    /// other currency, pulling the input from and paying the output to the caller. The caller must
    /// have approved this contract for the input currency.
    /// @param key The pool to swap through.
    /// @param zeroForOne Whether the input currency is the pool's `currency0`.
    /// @param amountIn Input amount, in the input currency's wei.
    /// @return delta0 The swap's `currency0` delta (negative = paid in).
    /// @return delta1 The swap's `currency1` delta (negative = paid in).
    function swapExactIn(V4PoolKey calldata key, bool zeroForOne, uint256 amountIn)
        external
        returns (int128 delta0, int128 delta1)
    {
        bytes memory result = POOL_MANAGER.unlock(abi.encode(Request(key, zeroForOne, amountIn, msg.sender)));
        (delta0, delta1) = abi.decode(result, (int128, int128));
    }

    /// @notice PoolManager unlock callback: performs the swap and settles both legs.
    /// @param data The ABI-encoded `Request`.
    /// @return The ABI-encoded currency deltas.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        Request memory request = abi.decode(data, (Request));

        int256 delta = POOL_MANAGER.swap(
            request.key,
            V4SwapParams({
                zeroForOne: request.zeroForOne,
                amountSpecified: -int256(request.amountIn),
                sqrtPriceLimitX96: request.zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE
            }),
            ""
        );

        int128 delta0 = int128(delta >> 128);
        int128 delta1 = int128(delta);
        _settleOrTake(request.key.currency0, delta0, request.trader);
        _settleOrTake(request.key.currency1, delta1, request.trader);
        return abi.encode(delta0, delta1);
    }

    /// @dev Pays a negative delta in from the trader, or takes a positive delta out to them.
    function _settleOrTake(address currency, int128 delta, address trader) internal {
        if (delta < 0) {
            POOL_MANAGER.sync(currency);
            IPoolToken(currency).transferFrom(trader, address(POOL_MANAGER), uint128(-delta));
            POOL_MANAGER.settle();
        } else if (delta > 0) {
            POOL_MANAGER.take(currency, trader, uint128(delta));
        }
    }
}
