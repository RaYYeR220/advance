// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Uniswap v3 SwapRouter02, as deployed on Base.
/// @dev Unlike the original v3 SwapRouter, `ExactInputSingleParams` has no `deadline` field.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of `tokenIn` for at least `amountOutMinimum` of `tokenOut`.
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
