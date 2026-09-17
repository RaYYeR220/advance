// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentCard} from "../../src/AgentCard.sol";
import {IFiatToken} from "../../src/interfaces/IFiatToken.sol";

/// @dev Real USDC's v/r/s `transferWithAuthorization` overload (selector
/// `0xe3ee160e`), used only to prove that overload alone -- without the bytes overload's
/// ERC-1271 routing -- can never move this card's funds.
interface IFiatTokenVRS {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @dev Metadata read purely for the fork sanity check.
interface IFiatTokenMeta {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
}

/// @notice Fork tests exercising AgentCard against the real USDC (FiatTokenV2_2) deployed on
/// Base mainnet. The bytes-signature overload of `transferWithAuthorization`
/// (`0xcf092995`) routes a contract `from` through ERC-1271 `isValidSignature`; these tests prove
/// the card's on-chain policy actually gates real USDC movement -- allowlisted payments succeed,
/// everything else reverts with the deployed token's own revert strings -- not just a unit-test
/// mock's approximation of that routing.
/// @dev Runs only under `FOUNDRY_PROFILE=fork` (`FOUNDRY_PROFILE=fork forge test --match-contract
/// AgentCardForkTest`); under any other profile `setUp` skips every test in this contract, so a
/// bare `forge test` never needs network access.
contract AgentCardForkTest is Test {
    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    IFiatToken internal constant USDC = IFiatToken(USDC_ADDRESS);

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal wrongPk = 0xBAD;
    address internal owner;
    address internal wrongOwner;
    address internal cardHub = makeAddr("cardHub");
    address internal relayer = makeAddr("relayer");
    /// @dev Bankr LLM gateway payTo from RECON's live x402 402 body (Spike 6).
    address internal payee = 0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0;
    address internal evil = makeAddr("evil");

    uint256 internal constant CAP = 10_000; // 0.01 USDC
    uint64 internal constant WINDOW = 300;
    uint256 internal constant CARD_BALANCE = 1_000_000; // 1 USDC

    AgentCard internal card;

    function setUp() public {
        if (!_isForkProfile()) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));

        owner = vm.addr(ownerPk);
        wrongOwner = vm.addr(wrongPk);
        // Base mainnet has seen EIP-7702 delegations land on well-known test private keys; strip
        // any code so SignatureChecker takes the ECDSA path for these signers, not ERC-1271.
        vm.etch(owner, "");
        vm.etch(wrongOwner, "");

        address[] memory payees = new address[](1);
        payees[0] = payee;
        card = new AgentCard(owner, cardHub, USDC_ADDRESS, CAP, WINDOW, payees);
        deal(USDC_ADDRESS, address(card), CARD_BALANCE);
        // A relayer or hub submitting a real transaction always carries gas money; fund both here
        // so the fork's simulated L2 fee accounting doesn't reject a call for an unrelated reason.
        vm.deal(relayer, 1 ether);
        vm.deal(cardHub, 1 ether);
    }

    function _isForkProfile() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) == keccak256(bytes("fork"));
    }

    function _digest(address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(card.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(card), to, value, va, vb, nonce));
        return keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash));
    }

    function _blob(uint256 pk, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory blob, bytes32 digest)
    {
        digest = _digest(to, value, va, vb, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        blob = abi.encode(abi.encodePacked(r, s, v), to, value, va, vb, nonce);
    }

    /// @dev Sanity check that the fork actually landed on the real deployed FiatTokenV2_2.
    function test_facts() public view {
        console2.log("block", block.number, "chainid", block.chainid);
        console2.log("name/version", IFiatTokenMeta(USDC_ADDRESS).name(), IFiatTokenMeta(USDC_ADDRESS).version());
        assertEq(IFiatTokenMeta(USDC_ADDRESS).version(), "2");
    }

    function test_allowlistedPayee_succeeds_andUsdcCalls1271() public {
        uint256 value = 1000;
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n1");
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payee, value, 0, vb, nonce);

        uint256 before = IERC20(USDC_ADDRESS).balanceOf(payee);
        // Proof: FiatTokenV2_2 routes contract `from` to ERC-1271 with the real EIP-712 digest
        // and our blob, exactly as the card's checks assume.
        vm.expectCall(address(card), abi.encodeCall(AgentCard.isValidSignature, (digest, blob)));
        vm.prank(relayer);
        USDC.transferWithAuthorization(address(card), payee, value, 0, vb, nonce, blob);

        assertEq(IERC20(USDC_ADDRESS).balanceOf(payee) - before, value);
        assertEq(IERC20(USDC_ADDRESS).balanceOf(address(card)), CARD_BALANCE - value);
        assertTrue(USDC.authorizationState(address(card), nonce));
    }

    function test_nonAllowlistedPayee_reverts() public {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n2");
        (bytes memory blob,) = _blob(ownerPk, evil, 1000, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(card), evil, 1000, 0, vb, nonce, blob);
    }

    function test_valueOverCap_reverts() public {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n3");
        (bytes memory blob,) = _blob(ownerPk, payee, CAP + 1, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(card), payee, CAP + 1, 0, vb, nonce, blob);
    }

    function test_validBeforeBeyondWindow_reverts() public {
        uint256 vb = block.timestamp + WINDOW + 1;
        bytes32 nonce = keccak256("n3b");
        (bytes memory blob,) = _blob(ownerPk, payee, 1000, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(card), payee, 1000, 0, vb, nonce, blob);
    }

    function test_wrongOwnerKey_reverts() public {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n4");
        (bytes memory blob,) = _blob(wrongPk, payee, 1000, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(card), payee, 1000, 0, vb, nonce, blob);
    }

    function test_replayedNonce_reverts() public {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n5");
        (bytes memory blob,) = _blob(ownerPk, payee, 1000, 0, vb, nonce);
        vm.prank(relayer);
        USDC.transferWithAuthorization(address(card), payee, 1000, 0, vb, nonce, blob);

        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        USDC.transferWithAuthorization(address(card), payee, 1000, 0, vb, nonce, blob);
    }

    /// @dev The blob says `payee`, but the relayer executes against `evil` -- the digest USDC
    /// computes from its own call arguments no longer matches the blob's own fields, so the
    /// card's digest-binding check must reject it.
    function test_blobFieldsMustMatchExecutedCall_reverts() public {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n6");
        (bytes memory blob,) = _blob(ownerPk, payee, 1000, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(card), evil, 1000, 0, vb, nonce, blob);
    }

    /// @dev The v/r/s overload with a plain owner EOA signature must NOT move card funds: it
    /// skips ERC-1271 entirely and recovers straight to an address, which can never equal this
    /// contract.
    function test_vrsOverload_ownerSigAlone_reverts() public {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n7");
        bytes32 digest = _digest(payee, 1000, 0, vb, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        IFiatTokenVRS(USDC_ADDRESS).transferWithAuthorization(address(card), payee, 1000, 0, vb, nonce, v, r, s);
    }

    function test_frozen_reverts() public {
        vm.prank(cardHub);
        card.freeze();

        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n8");
        (bytes memory blob,) = _blob(ownerPk, payee, 1000, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(card), payee, 1000, 0, vb, nonce, blob);
    }
}
