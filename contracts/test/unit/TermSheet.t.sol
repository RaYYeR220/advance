// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TermSheet, TermSheetLib} from "../../src/lib/TermSheetLib.sol";

/// @notice Unit tests for TermSheetLib: typehash correctness and a fixed cross-language
/// EIP-712 digest vector shared with the TypeScript implementation (packages/core).
contract TermSheetTest is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    string internal constant VECTOR_PATH = "test/vectors/termsheet.json";

    function test_typehash() public pure {
        assertEq(
            TermSheetLib.TYPEHASH,
            keccak256(
                "TermSheet(address agentTreasury,address agentCard,uint256 agentId,address feesManager,bytes32 poolId,uint256 expectedShares,uint256 noteSupply,uint16 floorCents,uint128 minPrincipal,uint64 auctionBlocks,uint128 drawLimit,uint64 drawPeriod,uint64 gracePeriod,uint64 deadline,uint256 nonce,bytes32 memoHash)"
            )
        );
    }

    function test_vectorDigest_writtenAndReread() public {
        TermSheet memory sheet = _vectorTermSheet();

        string memory name = "Advance";
        string memory version = "1";
        uint256 chainId = 8453;
        // Same 20-byte value as 0x00000000000000000000000000000000000A11CE; EIP-55 checksummed
        // so solc accepts the literal (casing carries no meaning beyond the checksum).
        address verifyingContract = 0x00000000000000000000000000000000000A11cE;

        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );

        bytes32 sHash = TermSheetLib.structHash(sheet);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, sHash));

        vm.writeJson(_vectorJson(sheet, name, version, chainId, verifyingContract, sHash, digest), VECTOR_PATH);

        string memory persisted = vm.readFile(VECTOR_PATH);
        bytes32 rereadStructHash = vm.parseJsonBytes32(persisted, ".structHash");
        bytes32 rereadDigest = vm.parseJsonBytes32(persisted, ".digest");

        assertEq(rereadStructHash, sHash, "structHash mismatch on reread");
        assertEq(rereadDigest, digest, "digest mismatch on reread");
    }

    function _vectorTermSheet() internal pure returns (TermSheet memory) {
        return TermSheet({
            agentTreasury: 0x96C33027948124a63E885fc34C29692d5A898765,
            agentCard: 0x1111111111111111111111111111111111111111,
            agentId: 88336,
            feesManager: 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544,
            poolId: 0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6,
            expectedShares: 950000000000000000,
            noteSupply: 5000000000000000000,
            floorCents: 80,
            minPrincipal: 2000000,
            auctionBlocks: 500,
            drawLimit: 250000,
            drawPeriod: 86400,
            gracePeriod: 1209600,
            deadline: 1790000000,
            nonce: 1,
            memoHash: keccak256("advance-vector")
        });
    }

    function _vectorJson(
        TermSheet memory sheet,
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract,
        bytes32 sHash,
        bytes32 digest
    ) internal pure returns (string memory) {
        string memory inputPart1 = string.concat(
            '{"agentTreasury":"',
            vm.toString(sheet.agentTreasury),
            '","agentCard":"',
            vm.toString(sheet.agentCard),
            '","agentId":"',
            vm.toString(sheet.agentId),
            '","feesManager":"',
            vm.toString(sheet.feesManager),
            '","poolId":"',
            vm.toString(sheet.poolId),
            '","expectedShares":"',
            vm.toString(sheet.expectedShares),
            '","noteSupply":"',
            vm.toString(sheet.noteSupply),
            '"'
        );
        string memory inputPart2 = string.concat(
            ',"floorCents":"',
            vm.toString(uint256(sheet.floorCents)),
            '","minPrincipal":"',
            vm.toString(uint256(sheet.minPrincipal)),
            '","auctionBlocks":"',
            vm.toString(uint256(sheet.auctionBlocks)),
            '","drawLimit":"',
            vm.toString(uint256(sheet.drawLimit)),
            '","drawPeriod":"',
            vm.toString(uint256(sheet.drawPeriod)),
            '","gracePeriod":"',
            vm.toString(uint256(sheet.gracePeriod)),
            '","deadline":"',
            vm.toString(uint256(sheet.deadline)),
            '","nonce":"',
            vm.toString(sheet.nonce),
            '","memoHash":"',
            vm.toString(sheet.memoHash),
            '"}'
        );

        string memory domainPart = string.concat(
            '{"name":"',
            name,
            '","version":"',
            version,
            '","chainId":',
            vm.toString(chainId),
            ',"verifyingContract":"',
            vm.toString(verifyingContract),
            '"}'
        );

        return string.concat(
            '{"input":',
            inputPart1,
            inputPart2,
            ',"domain":',
            domainPart,
            ',"structHash":"',
            vm.toString(sHash),
            '","digest":"',
            vm.toString(digest),
            '"}'
        );
    }
}
