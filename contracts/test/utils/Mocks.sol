// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IChainlink} from "../../src/interfaces/IChainlink.sol";

/// @notice Minimal Chainlink `AggregatorV3Interface` mock with settable answer/startedAt/updatedAt,
/// used for both the ETH/USD feed and the L2 sequencer uptime feed in OracleLib tests.
contract MockFeed is IChainlink {
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint8 public feedDecimals = 8;

    function setAnswer(int256 answer_) external {
        answer = answer_;
    }

    function setStartedAt(uint256 startedAt_) external {
        startedAt = startedAt_;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function setDecimals(uint8 decimals_) external {
        feedDecimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt_, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (0, answer, startedAt, updatedAt, 0);
    }
}

/// @notice Minimal mintable ERC20 with configurable decimals, standing in for USDC (6 decimals)
/// in RevenueNote tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
