// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {RevenueEscrow} from "../RevenueEscrow.sol";

/// @title EscrowDeployer
/// @notice Stateless helper that holds RevenueEscrow's creation code so AdvanceHub's own deployment
/// stays within the EIP-3860 initcode limit. Deployed once per chain and passed to the hub's
/// constructor, it is always called (never delegatecalled), so it keeps no state of its own and
/// touches no hub storage.
/// @dev Escrow addresses are CREATE2 addresses of this contract, derived from the escrow's whole
/// configuration and the term sheet's struct hash. `deploy` only accepts a configuration naming its
/// own caller as hub, so nobody else can create an escrow that reports another hub, and deploying
/// one first is pointless: the address is a pure function of the configuration and salt, so it is
/// the same contract the hub would have deployed.
contract EscrowDeployer {
    /// @notice Thrown when the configuration's `hub` is not the caller.
    error NotHub();

    /// @notice Deploys the escrow for `cfg` and `salt` unless it already exists. `cfg.hub` must be
    /// the caller, which becomes the escrow's hub. Idempotent.
    /// @param cfg The escrow's constructor configuration.
    /// @param salt The CREATE2 salt (the hub passes the term sheet's EIP-712 struct hash).
    /// @return escrow The escrow's address.
    function deploy(RevenueEscrow.Config calldata cfg, bytes32 salt) external returns (address escrow) {
        if (cfg.hub != msg.sender) revert NotHub();
        escrow = predict(cfg, salt);
        if (escrow.code.length == 0) {
            escrow = address(new RevenueEscrow{salt: salt}(cfg));
        }
    }

    /// @notice The address `deploy` uses for `cfg` and `salt`, whether or not it is deployed yet.
    /// @param cfg The escrow's constructor configuration.
    /// @param salt The CREATE2 salt.
    /// @return The predicted escrow address.
    function predict(RevenueEscrow.Config memory cfg, bytes32 salt) public view returns (address) {
        // Creation code followed by its ABI-encoded constructor arguments is the exact init code;
        // only the arguments vary, so no two configurations share a preimage.
        // forge-lint: disable-next-line(encode-packed-collision)
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(RevenueEscrow).creationCode, abi.encode(cfg)));
        return Create2.computeAddress(salt, initCodeHash);
    }
}
