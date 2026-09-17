// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AdvanceHub} from "../../src/AdvanceHub.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {IAdvance} from "../../src/interfaces/IAdvance.sol";
import {IDopplerFeesManager} from "../../src/interfaces/IDopplerFeesManager.sol";
import {TermSheet} from "../../src/lib/TermSheetLib.sol";
import {ForkBase} from "./ForkBase.sol";

/// @notice The escape hatch for an agent that pledges its live Doppler fee share to a term sheet
/// and then never borrows against it. The shares sit at an address that holds no code until
/// someone deploys it, and after the term sheet's deadline anyone can abort: the escrow is deployed
/// at its predicted address, the fee share goes back to the agent treasury, and the term sheet can
/// never open a loan afterwards.
contract AbortForkTest is ForkBase {
    function test_abort_afterTheDeadline_returnsTheFeeShare() public {
        TermSheet memory ts = _termSheet();
        address escrow = _onboard(ts);
        console2.log("predicted escrow", escrow);

        // The share is already pledged even though nothing has been deployed there.
        assertEq(escrow.code.length, 0, "no code at the pledged address yet");
        assertEq(_shares(escrow), CREATOR_SHARES, "the fee share sits at the predicted escrow");
        assertEq(_shares(POOL_CREATOR), 0, "the treasury handed it over");

        uint256 treasuryWeth = IERC20(WETH).balanceOf(POOL_CREATOR);
        vm.warp(uint256(ts.deadline) + 1);
        vm.prank(keeper);
        uint256 before = gasleft();
        hub.abort(ts);
        console2.log("abort gas", before - gasleft());

        assertGt(escrow.code.length, 0, "abort deployed the escrow it releases");
        assertEq(uint8(RevenueEscrow(payable(escrow)).phase()), uint8(RevenueEscrow.Phase.Closed), "escrow closed");
        assertEq(_shares(escrow), 0, "escrow holds nothing");
        assertEq(_shares(POOL_CREATOR), CREATOR_SHARES, "fee share back with the agent treasury");
        assertEq(IERC20(WETH).balanceOf(escrow), 0, "released fees forwarded, nothing stranded");
        assertEq(IERC20(AGENT_TOKEN).balanceOf(escrow), 0, "agent leg forwarded too");
        // `release` collects first, so the fees that accrued while the share was pledged are paid
        // out to the agent rather than stranded at the escrow.
        assertGt(IERC20(WETH).balanceOf(POOL_CREATOR), treasuryWeth, "collected fees reached the treasury");

        assertTrue(hub.aborted(_hash(ts)), "term sheet recorded as aborted");
        assertEq(uint8(hub.termSheetStatus(_hash(ts))), uint8(IAdvance.LoanStatus.Aborted), "status");
        assertEq(hub.loanCount(), 0, "no loan was ever opened");
    }

    function test_abort_beforeTheDeadline_reverts() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);

        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotExpired.selector);
        hub.abort(ts);

        vm.warp(ts.deadline);
        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotExpired.selector);
        hub.abort(ts);
    }

    function test_abort_isOnceOnlyAndClosesTheTermSheet() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        vm.warp(uint256(ts.deadline) + 1);
        vm.prank(keeper);
        hub.abort(ts);

        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.AlreadyAborted.selector);
        hub.abort(ts);

        // Re-pledging the share cannot revive an aborted term sheet, and the deadline is past anyway.
        address escrow = hub.predictEscrow(ts);
        vm.prank(POOL_CREATOR);
        IDopplerFeesManager(FEES_MANAGER).updateBeneficiary(POOL_ID, escrow);
        assertEq(_shares(escrow), CREATOR_SHARES, "the share is pledged again");
        bytes memory signature = _sign(ts);
        vm.prank(POOL_CREATOR);
        vm.expectRevert(AdvanceHub.Expired.selector);
        hub.openLoan(ts, signature);
    }

    function test_abort_onAnAlreadyDeployedEscrow_stillReleases() public {
        TermSheet memory ts = _termSheet();
        address escrow = _onboard(ts);
        // Anyone may deploy the escrow early; it changes nothing about who controls it.
        vm.prank(keeper);
        assertEq(hub.deployEscrow(ts), escrow, "deployEscrow lands on the predicted address");
        assertGt(escrow.code.length, 0, "deployed");
        assertEq(RevenueEscrow(payable(escrow)).hub(), address(hub), "the hub owns it");

        vm.warp(uint256(ts.deadline) + 1);
        vm.prank(keeper);
        hub.abort(ts);
        assertEq(_shares(POOL_CREATOR), CREATOR_SHARES, "fee share back with the agent treasury");
    }
}
