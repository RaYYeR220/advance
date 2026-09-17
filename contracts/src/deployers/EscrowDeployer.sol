// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {RevenueEscrow} from "../RevenueEscrow.sol";

/// @title EscrowDeployer
/// @notice Linked library holding RevenueEscrow's creation code, so AdvanceHub's own deployment
/// stays within the EIP-3860 initcode limit. Its functions run by DELEGATECALL in the hub's
/// context, so every escrow is CREATE2-deployed by the hub itself; called directly (not by
/// DELEGATECALL) `deploy` reverts.
library EscrowDeployer {
    /// @notice Deploys the escrow for `cfg` at its CREATE2 address for `salt`, from the calling
    /// contract, unless it already exists. Idempotent.
    /// @param cfg The escrow's constructor configuration.
    /// @param salt The CREATE2 salt.
    /// @return escrow The escrow's address.
    function deploy(RevenueEscrow.Config memory cfg, bytes32 salt) public returns (address escrow) {
        escrow = predict(cfg, salt, address(this));
        if (escrow.code.length == 0) {
            escrow = address(new RevenueEscrow{salt: salt}(cfg));
        }
    }

    /// @notice The address `deploy` uses when called from `deployer` with `cfg` and `salt`.
    /// @param cfg The escrow's constructor configuration.
    /// @param salt The CREATE2 salt.
    /// @param deployer The contract deploying the escrow.
    /// @return The predicted escrow address.
    function predict(RevenueEscrow.Config memory cfg, bytes32 salt, address deployer) public pure returns (address) {
        // Creation code followed by its ABI-encoded constructor arguments is the exact init code;
        // only the arguments vary, so no two configurations share a preimage.
        // forge-lint: disable-next-line(encode-packed-collision)
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(RevenueEscrow).creationCode, abi.encode(cfg)));
        return Create2.computeAddress(salt, initCodeHash, deployer);
    }
}
