// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {CreditLine} from "../CreditLine.sol";
import {RevenueNote} from "../RevenueNote.sol";

/// @title LoanDeployer
/// @notice Linked library holding CreditLine's and RevenueNote's creation code, so AdvanceHub's own
/// deployment stays within the EIP-3860 initcode limit. Its functions run by DELEGATECALL in the
/// hub's context, so the hub itself deploys each contract and is recorded as its controller;
/// called directly (not by DELEGATECALL) they revert.
library LoanDeployer {
    /// @notice Deploys a loan's credit line controlled by the calling contract.
    /// @param usdc USDC token the credit line custodies.
    /// @param card The agent's card; the only address allowed to draw.
    /// @param treasury The agent treasury; receives what is left over on freeze or close.
    /// @param drawLimit Maximum USDC drawable per draw period.
    /// @param drawPeriod Length, in seconds, of one draw period.
    /// @return The deployed credit line.
    function deployCreditLine(address usdc, address card, address treasury, uint128 drawLimit, uint64 drawPeriod)
        public
        returns (address)
    {
        return address(new CreditLine(address(this), usdc, card, treasury, drawLimit, drawPeriod));
    }

    /// @notice Deploys a loan's revenue note controlled by the calling contract, named
    /// "Advance Revenue Note #<loanId>" with symbol "arN<loanId>".
    /// @param loanId The loan id the note is issued for.
    /// @param usdc USDC token repayments are paid in.
    /// @return The deployed note.
    function deployNote(uint256 loanId, address usdc) public returns (address) {
        string memory id = Strings.toString(loanId);
        return address(
            new RevenueNote(string.concat("Advance Revenue Note #", id), string.concat("arN", id), address(this), usdc)
        );
    }
}
