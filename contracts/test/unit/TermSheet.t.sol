// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TermSheet, TermSheetLib} from "../../src/lib/TermSheetLib.sol";
import {TermSheetVector} from "../utils/Vectors.sol";

/// @notice Unit tests for TermSheetLib: typehash correctness and the fixed cross-language EIP-712
/// vector shared with the TypeScript implementation (packages/core). The vector file is a
/// read-only fixture here; `script/WriteTermSheetVector.s.sol` is the only thing that writes it.
contract TermSheetTest is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function test_typehash() public pure {
        assertEq(
            TermSheetLib.TYPEHASH,
            keccak256(
                "TermSheet(address agentTreasury,address agentCard,uint256 agentId,address feesManager,bytes32 poolId,uint256 expectedShares,uint256 noteSupply,uint16 floorCents,uint128 minPrincipal,uint64 auctionBlocks,uint128 drawLimit,uint64 drawPeriod,uint64 gracePeriod,uint64 deadline,uint256 nonce,bytes32 memoHash)"
            )
        );
    }

    function test_committedVector_matchesTheLibrary() public view {
        string memory json = TermSheetVector.read();
        TermSheet memory sheet = TermSheetVector.termSheet(json);
        (string memory name, string memory version, uint256 chainId, address verifyingContract) =
            TermSheetVector.domain(json);

        assertEq(name, "Advance", "domain name");
        assertEq(version, "1", "domain version");

        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
        bytes32 structHash = TermSheetLib.structHash(sheet);

        assertEq(structHash, TermSheetVector.structHash(json), "structHash");
        assertEq(
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)), TermSheetVector.digest(json), "digest"
        );
    }
}
