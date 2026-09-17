// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {OracleLib} from "../../src/lib/OracleLib.sol";
import {MockFeed} from "../utils/Mocks.sol";

/// @notice Externalizes OracleLib's internal function so `vm.expectRevert` targets the whole
/// call frame instead of the mock feed's nested staticcall.
contract OracleLibHarness {
    function minUsdcOut(
        uint256 wethIn,
        address ethUsdFeed,
        address sequencerFeed,
        uint256 maxStaleness,
        uint256 slippageBps
    ) external view returns (uint256) {
        return OracleLib.minUsdcOut(wethIn, ethUsdFeed, sequencerFeed, maxStaleness, slippageBps);
    }
}

/// @notice Unit tests for OracleLib.minUsdcOut: price math, staleness, and L2 sequencer guards.
contract OracleLibTest is Test {
    uint256 internal constant MAX_STALENESS = 3600;
    uint256 internal constant GRACE_PERIOD = 3600;

    MockFeed internal ethUsdFeed;
    MockFeed internal sequencerFeed;
    OracleLibHarness internal harness;

    function setUp() public {
        ethUsdFeed = new MockFeed();
        sequencerFeed = new MockFeed();
        harness = new OracleLibHarness();
        vm.warp(10_000_000);
    }

    function test_minUsdcOut_computesSlippageAdjustedAmount() public {
        ethUsdFeed.setAnswer(2400e8);
        ethUsdFeed.setUpdatedAt(block.timestamp);

        uint256 out = harness.minUsdcOut(1e16, address(ethUsdFeed), address(0), MAX_STALENESS, 100);

        assertEq(out, 23_760_000);
    }

    function test_minUsdcOut_revertsOnStalePrice() public {
        ethUsdFeed.setAnswer(2400e8);
        ethUsdFeed.setUpdatedAt(block.timestamp - MAX_STALENESS - 1);

        vm.expectRevert(OracleLib.StalePrice.selector);
        harness.minUsdcOut(1e16, address(ethUsdFeed), address(0), MAX_STALENESS, 100);
    }

    function test_minUsdcOut_revertsOnBadPrice() public {
        ethUsdFeed.setAnswer(0);
        ethUsdFeed.setUpdatedAt(block.timestamp);

        vm.expectRevert(OracleLib.BadPrice.selector);
        harness.minUsdcOut(1e16, address(ethUsdFeed), address(0), MAX_STALENESS, 100);
    }

    function test_minUsdcOut_revertsWhenSequencerDown() public {
        sequencerFeed.setAnswer(1);
        sequencerFeed.setStartedAt(block.timestamp - 2 * GRACE_PERIOD);

        ethUsdFeed.setAnswer(2400e8);
        ethUsdFeed.setUpdatedAt(block.timestamp);

        vm.expectRevert(OracleLib.SequencerDown.selector);
        harness.minUsdcOut(1e16, address(ethUsdFeed), address(sequencerFeed), MAX_STALENESS, 100);
    }

    function test_minUsdcOut_revertsDuringSequencerGracePeriod() public {
        sequencerFeed.setAnswer(0);
        sequencerFeed.setStartedAt(block.timestamp - (GRACE_PERIOD - 1));

        ethUsdFeed.setAnswer(2400e8);
        ethUsdFeed.setUpdatedAt(block.timestamp);

        vm.expectRevert(OracleLib.SequencerGracePeriod.selector);
        harness.minUsdcOut(1e16, address(ethUsdFeed), address(sequencerFeed), MAX_STALENESS, 100);
    }

    function test_minUsdcOut_skipsSequencerChecksWhenFeedIsZero() public {
        // Sequencer mock reports "down", but since we pass address(0) it must never be read.
        sequencerFeed.setAnswer(1);
        sequencerFeed.setStartedAt(block.timestamp);

        ethUsdFeed.setAnswer(2400e8);
        ethUsdFeed.setUpdatedAt(block.timestamp);

        uint256 out = harness.minUsdcOut(1e16, address(ethUsdFeed), address(0), MAX_STALENESS, 100);

        assertEq(out, 23_760_000);
    }
}
