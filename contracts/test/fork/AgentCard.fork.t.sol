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

/// @dev Real USDC's EIP-2612 `permit` bytes-signature overload and its nonce counter, used only
/// to prove a permit-shaped digest can never be mistaken for a payment authorization by this
/// card's ERC-1271 check.
interface IFiatTokenPermit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) external;
    function nonces(address owner) external view returns (uint256);
}

/// @notice Fork tests exercising AgentCard against the real USDC (FiatTokenV2_2) deployed on
/// Base mainnet. The bytes-signature overload of `transferWithAuthorization`
/// (`0xcf092995`) routes a contract `from` through ERC-1271 `isValidSignature`; these tests prove
/// the card's on-chain policy actually gates real USDC movement -- allowlisted payments succeed,
/// everything else reverts with the deployed token's own revert strings -- not just a unit-test
/// mock's approximation of that routing.
/// @dev Runs against the `fork` profile (`FOUNDRY_PROFILE=fork forge test --match-contract
/// AgentCard`), which pins the fork to Base mainnet block 51403692 in `foundry.toml`; `setUp`
/// additionally skips every test in this contract unless it actually landed on Base (chain id
/// 8453), so a bare `forge test` never needs network access even if this file is discovered.
contract AgentCardForkTest is Test {
    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    IFiatToken internal constant USDC = IFiatToken(USDC_ADDRESS);
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal wrongPk = 0xBAD;
    address internal owner;
    address internal wrongOwner;
    address internal cardHub = makeAddr("cardHub");
    address internal relayer = makeAddr("relayer");
    /// @dev Bankr LLM gateway x402 payTo.
    address internal payee = 0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0;
    address internal evil = makeAddr("evil");

    uint256 internal constant CAP = 10_000; // 0.01 USDC
    uint64 internal constant WINDOW = 300;
    uint256 internal constant CARD_BALANCE = 1_000_000; // 1 USDC

    AgentCard internal card;

    function setUp() public {
        // The `fork` profile forks Base at a pinned block automatically (see foundry.toml); a
        // plain `forge test` never forks, so this skips instead of hitting the network or acting
        // on an unforked chain id.
        if (block.chainid != 8453) {
            vm.skip(true);
            return;
        }

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

    /// @dev Sanity check that the fork actually landed on the real deployed FiatTokenV2_2, at the
    /// pinned block.
    function test_facts() public view {
        console2.log("block", block.number, "chainid", block.chainid);
        console2.log("name/version", IFiatTokenMeta(USDC_ADDRESS).name(), IFiatTokenMeta(USDC_ADDRESS).version());
        assertEq(block.number, 51403692);
        assertEq(IFiatTokenMeta(USDC_ADDRESS).name(), "USD Coin");
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

    /// @dev The classic ERC-1271 drain: USDC's `permit` bytes overload also routes a contract
    /// `owner` through `isValidSignature`. `ownerSig` here is a genuine signature over the real
    /// permit digest (as if the owner key had been tricked into blind-signing it), wrapped in a
    /// blob whose own decoded fields lie and describe an innocuous allowlisted payment. If the
    /// card ever approved this, `evil` would walk away with an ERC20 `approve` over the card's
    /// USDC and could drain it with a plain `transferFrom` -- no EIP-3009 authorization needed
    /// again. The digest-binding check must still catch it: the card recomputes a
    /// TransferWithAuthorization-typehash digest from the blob's fields, which can never equal a
    /// Permit-typehash digest, so `permit` reverts exactly like every other forged request.
    function test_permitBytesOverload_reverts() public {
        uint256 value = type(uint256).max;
        uint256 deadline = block.timestamp + 60;
        uint256 nonce = IFiatTokenPermit(USDC_ADDRESS).nonces(address(card));
        bytes32 permitStructHash = keccak256(abi.encode(PERMIT_TYPEHASH, address(card), evil, value, nonce, deadline));
        bytes32 permitDigest = keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), permitStructHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, permitDigest);
        bytes memory ownerSig = abi.encodePacked(r, s, v);
        bytes memory blob = abi.encode(ownerSig, payee, uint256(1000), uint256(0), deadline, keccak256("permit-n1"));

        vm.expectRevert(bytes("EIP2612: invalid signature"));
        IFiatTokenPermit(USDC_ADDRESS).permit(address(card), evil, value, deadline, blob);
    }
}
