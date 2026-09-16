// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Canonical WETH9, extended with the wrap/unwrap functions beyond plain ERC20.
/// @dev Base mainnet and Base Sepolia: 0x4200000000000000000000000000000000000006.
interface IWETH is IERC20 {
    /// @notice Wraps the attached ETH into WETH, crediting the caller.
    function deposit() external payable;

    /// @notice Unwraps `amount` of WETH into ETH, sent to the caller.
    function withdraw(uint256 amount) external;
}
