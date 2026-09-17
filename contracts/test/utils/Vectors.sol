// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VmSafe} from "forge-std/Vm.sol";
import {TermSheet} from "../../src/lib/TermSheetLib.sol";

/// @notice Reads the committed cross-language TermSheet vector. The file is a fixture: it is only
/// written by `script/WriteTermSheetVector.s.sol`, never by a test, so both the Solidity and the
/// TypeScript encoding are checked against the same fixed bytes.
library TermSheetVector {
    VmSafe private constant VM = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Path of the committed vector, relative to the Foundry project root.
    string internal constant PATH = "test/vectors/termsheet.json";

    /// @notice The vector file's contents.
    /// @return The raw JSON.
    function read() internal view returns (string memory) {
        return VM.readFile(PATH);
    }

    /// @notice The term sheet the vector was built from.
    /// @param json The vector's JSON.
    /// @return The term sheet.
    function termSheet(string memory json) internal pure returns (TermSheet memory) {
        return TermSheet({
            agentTreasury: VM.parseJsonAddress(json, ".input.agentTreasury"),
            agentCard: VM.parseJsonAddress(json, ".input.agentCard"),
            agentId: VM.parseJsonUint(json, ".input.agentId"),
            feesManager: VM.parseJsonAddress(json, ".input.feesManager"),
            poolId: VM.parseJsonBytes32(json, ".input.poolId"),
            expectedShares: VM.parseJsonUint(json, ".input.expectedShares"),
            noteSupply: VM.parseJsonUint(json, ".input.noteSupply"),
            floorCents: uint16(VM.parseJsonUint(json, ".input.floorCents")),
            minPrincipal: uint128(VM.parseJsonUint(json, ".input.minPrincipal")),
            auctionBlocks: uint64(VM.parseJsonUint(json, ".input.auctionBlocks")),
            drawLimit: uint128(VM.parseJsonUint(json, ".input.drawLimit")),
            drawPeriod: uint64(VM.parseJsonUint(json, ".input.drawPeriod")),
            gracePeriod: uint64(VM.parseJsonUint(json, ".input.gracePeriod")),
            deadline: uint64(VM.parseJsonUint(json, ".input.deadline")),
            nonce: VM.parseJsonUint(json, ".input.nonce"),
            memoHash: VM.parseJsonBytes32(json, ".input.memoHash")
        });
    }

    /// @notice The EIP-712 domain the vector's digest was computed over.
    /// @param json The vector's JSON.
    /// @return name The domain name.
    /// @return version The domain version.
    /// @return chainId The domain chain id.
    /// @return verifyingContract The domain's verifying contract.
    function domain(string memory json)
        internal
        pure
        returns (string memory name, string memory version, uint256 chainId, address verifyingContract)
    {
        name = VM.parseJsonString(json, ".domain.name");
        version = VM.parseJsonString(json, ".domain.version");
        chainId = VM.parseJsonUint(json, ".domain.chainId");
        verifyingContract = VM.parseJsonAddress(json, ".domain.verifyingContract");
    }

    /// @notice The vector's expected EIP-712 struct hash.
    /// @param json The vector's JSON.
    /// @return The struct hash.
    function structHash(string memory json) internal pure returns (bytes32) {
        return VM.parseJsonBytes32(json, ".structHash");
    }

    /// @notice The vector's expected EIP-712 digest.
    /// @param json The vector's JSON.
    /// @return The digest.
    function digest(string memory json) internal pure returns (bytes32) {
        return VM.parseJsonBytes32(json, ".digest");
    }
}
