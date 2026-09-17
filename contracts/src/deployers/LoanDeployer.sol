// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {CreditLine} from "../CreditLine.sol";
import {RevenueNote} from "../RevenueNote.sol";

/// @title LoanDeployer
/// @notice Stateless helper that holds CreditLine's and RevenueNote's creation code so AdvanceHub's
/// own deployment stays within the EIP-3860 initcode limit. Deployed once per chain and passed to
/// the hub's constructor, it is always called (never delegatecalled), so it keeps no state of its
/// own and touches no hub storage.
/// @dev Every contract it deploys records its caller as the hub, so a contract naming a given hub
/// can only have been deployed by that hub.
contract LoanDeployer {
    /// @notice Deploys a credit line controlled by the caller.
    /// @param usdc USDC token the credit line custodies.
    /// @param card The agent's card; the only address allowed to draw.
    /// @param treasury The agent treasury; receives what is left over on freeze or close.
    /// @param drawLimit Maximum USDC drawable per draw period.
    /// @param drawPeriod Length, in seconds, of one draw period.
    /// @return The deployed credit line.
    function deployCreditLine(address usdc, address card, address treasury, uint128 drawLimit, uint64 drawPeriod)
        external
        returns (address)
    {
        return address(new CreditLine(msg.sender, usdc, card, treasury, drawLimit, drawPeriod));
    }

    /// @notice Deploys a revenue note controlled by the caller, named "Advance Revenue Note #<loanId>"
    /// with symbol "arN<loanId>".
    /// @param loanId The loan id the note is issued for.
    /// @param usdc USDC token repayments are paid in.
    /// @return The deployed note.
    function deployNote(uint256 loanId, address usdc) external returns (address) {
        string memory id = Strings.toString(loanId);
        return address(
            new RevenueNote(string.concat("Advance Revenue Note #", id), string.concat("arN", id), msg.sender, usdc)
        );
    }
}
