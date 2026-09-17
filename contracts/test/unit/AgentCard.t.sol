// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AgentCard} from "../../src/AgentCard.sol";
import {IAgentCard} from "../../src/interfaces/IAgentCard.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockAuction, MockHub, MockEIP3009USDC, MockUnderfillingCreditLine} from "../utils/Mocks.sol";

/// @notice Unit tests for AgentCard: the `isValidSignature` policy (allowlist, cap, authorization
/// window, digest binding, owner signature, malformed-blob safety, frozen state), `drawCredit`
/// against a real CreditLine, and the hub's freeze/unfreeze/returnFunds controls.
contract AgentCardTest is Test {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;
    bytes4 internal constant INVALID_SIGNATURE = 0xffffffff;

    uint256 internal constant LOAN_ID = 1;
    uint256 internal constant NOTE_SUPPLY = 5e18;
    uint128 internal constant DRAW_LIMIT = 250_000;
    uint64 internal constant DRAW_PERIOD = 1 days;
    uint64 internal constant END_BLOCK = 1000;

    uint256 internal constant CAP = 10_000;
    uint64 internal constant WINDOW = 300;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal wrongPk = 0xBAD;
    address internal owner;
    address internal cardHub = makeAddr("cardHub");
    address internal payeeA = makeAddr("payeeA");
    address internal evil = makeAddr("evil");
    address internal relayer = makeAddr("relayer");
    address internal treasury = makeAddr("treasury");
    address internal escrow = makeAddr("escrow");

    MockEIP3009USDC internal usdc;
    AgentCard internal card;

    MockHub internal clHub;
    RevenueNote internal note;
    CreditLine internal creditLine;
    MockAuction internal auction;

    function setUp() public {
        owner = vm.addr(ownerPk);
        usdc = new MockEIP3009USDC("USD Coin");

        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        card = new AgentCard(owner, cardHub, address(usdc), CAP, WINDOW, payees);

        vm.roll(1);
        clHub = new MockHub();
        note = new RevenueNote("Advance Note", "ADVN", address(clHub), address(usdc));
        creditLine = new CreditLine(address(clHub), address(usdc), address(card), treasury, DRAW_LIMIT, DRAW_PERIOD);
        auction = new MockAuction(address(usdc), address(note), address(creditLine), address(creditLine), END_BLOCK);

        vm.prank(address(clHub));
        note.initialize(escrow, address(creditLine));
        vm.prank(address(clHub));
        creditLine.initialize(LOAN_ID, address(auction), address(note));
    }

    // -- helpers --

    function _digest(address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(card.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(card), to, value, va, vb, nonce));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
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

    function _settleGraduated(uint256 raised) internal {
        vm.prank(address(clHub));
        note.mint(address(auction), NOTE_SUPPLY);
        usdc.mint(address(auction), raised);
        auction.setGraduated(true);
        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();
    }

    // -- isValidSignature policy --

    function test_isValidSignature_allowlistedWithinCapFreshWindow_returnsMagicValue() public view {
        uint256 vb = block.timestamp + 60;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payeeA, 1000, 0, vb, keccak256("n1"));
        assertEq(card.isValidSignature(digest, blob), MAGICVALUE);
    }

    function test_transferWithAuthorization_allowlistedPayee_succeeds() public {
        usdc.mint(address(card), 1_000_000);
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n2");
        (bytes memory blob,) = _blob(ownerPk, payeeA, 1000, 0, vb, nonce);

        vm.prank(relayer);
        usdc.transferWithAuthorization(address(card), payeeA, 1000, 0, vb, nonce, blob);

        assertEq(usdc.balanceOf(payeeA), 1000);
        assertEq(usdc.balanceOf(address(card)), 1_000_000 - 1000);
        assertTrue(usdc.authorizationState(address(card), nonce));
    }

    function test_isValidSignature_nonAllowlistedPayee_returnsInvalid() public view {
        uint256 vb = block.timestamp + 60;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, evil, 1000, 0, vb, keccak256("n3"));
        assertEq(card.isValidSignature(digest, blob), INVALID_SIGNATURE);
    }

    function test_isValidSignature_valueOverCap_returnsInvalid() public view {
        uint256 vb = block.timestamp + 60;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payeeA, CAP + 1, 0, vb, keccak256("n4"));
        assertEq(card.isValidSignature(digest, blob), INVALID_SIGNATURE);
    }

    function test_isValidSignature_validBeforeBeyondWindow_returnsInvalid() public view {
        uint256 vb = block.timestamp + WINDOW + 1;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payeeA, 1000, 0, vb, keccak256("n5"));
        assertEq(card.isValidSignature(digest, blob), INVALID_SIGNATURE);
    }

    function test_isValidSignature_validBeforeAtWindowBoundary_returnsMagicValue() public view {
        uint256 vb = block.timestamp + WINDOW;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payeeA, 1000, 0, vb, keccak256("n5b"));
        assertEq(card.isValidSignature(digest, blob), MAGICVALUE);
    }

    function test_isValidSignature_wrongOwnerKey_returnsInvalid() public view {
        uint256 vb = block.timestamp + 60;
        (bytes memory blob, bytes32 digest) = _blob(wrongPk, payeeA, 1000, 0, vb, keccak256("n6"));
        assertEq(card.isValidSignature(digest, blob), INVALID_SIGNATURE);
    }

    /// `ownerSig` genuinely recovers to `owner` for `hash` (a real authorization to move 999_999
    /// to `evil`), but the blob's own decoded fields lie about it, claiming a small payment to
    /// the allowlisted payee -- exactly the fields the allowlist/cap/window checks run against.
    /// The digest-binding check must recompute the digest from those same decoded fields and
    /// reject the mismatch with `hash`; the owner-signature check alone would not catch this,
    /// since `ownerSig` is a genuine signature over `hash` itself.
    function test_isValidSignature_hashMismatchWithBlobFields_returnsInvalid() public view {
        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("n7");
        bytes32 realDigest = _digest(evil, 999_999, 0, vb, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, realDigest);
        bytes memory ownerSig = abi.encodePacked(r, s, v);
        bytes memory blob = abi.encode(ownerSig, payeeA, uint256(1000), uint256(0), vb, nonce);

        assertEq(card.isValidSignature(realDigest, blob), INVALID_SIGNATURE);
    }

    function test_isValidSignature_frozen_returnsInvalid() public {
        vm.prank(cardHub);
        card.freeze();

        uint256 vb = block.timestamp + 60;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payeeA, 1000, 0, vb, keccak256("n8"));
        assertEq(card.isValidSignature(digest, blob), INVALID_SIGNATURE);
    }

    function test_isValidSignature_malformedBlob_returnsInvalidWithoutRevert() public view {
        bytes memory garbage = new bytes(64);
        assertEq(card.isValidSignature(bytes32(uint256(1)), garbage), INVALID_SIGNATURE);
    }

    function test_isValidSignature_emptyBlob_returnsInvalidWithoutRevert() public view {
        assertEq(card.isValidSignature(bytes32(uint256(1)), ""), INVALID_SIGNATURE);
    }

    // -- drawCredit --

    function test_drawCredit_byNonOwner_reverts() public {
        _settleGraduated(1_000_000);
        vm.expectRevert(IAgentCard.NotOwner.selector);
        card.drawCredit(address(creditLine), 1000);
    }

    function test_drawCredit_byOwner_drawsFromCreditLineAndIncreasesBalance() public {
        _settleGraduated(1_000_000);
        uint256 before = usdc.balanceOf(address(card));

        vm.expectEmit(true, false, false, true, address(card));
        emit IAgentCard.CreditDrawn(address(creditLine), 40_000);

        vm.prank(owner);
        card.drawCredit(address(creditLine), 40_000);

        assertEq(usdc.balanceOf(address(card)) - before, 40_000);
        assertEq(creditLine.totalDrawn(), 40_000);
    }

    /// A real CreditLine always transfers exactly what was requested or reverts, so it can never
    /// show whether `CreditDrawn` reports the requested argument or the measured balance delta.
    /// This credit line stand-in deliberately pays out a different, fixed amount, and only
    /// implements `draw(uint256)` -- proving both that the event reflects what was actually
    /// received and that `drawCredit` only depends on that minimal interface.
    function test_drawCredit_emitsMeasuredAmountNotRequestedArgument() public {
        MockUnderfillingCreditLine underfilling = new MockUnderfillingCreditLine(address(usdc));
        usdc.mint(address(underfilling), 100_000);
        underfilling.setActualAmount(37_000);

        vm.expectEmit(true, false, false, true, address(card));
        emit IAgentCard.CreditDrawn(address(underfilling), 37_000);

        vm.prank(owner);
        card.drawCredit(address(underfilling), 999_999);

        assertEq(usdc.balanceOf(address(card)), 37_000);
    }

    // -- hub controls --

    function test_freeze_byNonHub_reverts() public {
        vm.expectRevert(IAgentCard.NotHub.selector);
        card.freeze();
    }

    function test_unfreeze_byNonHub_reverts() public {
        vm.expectRevert(IAgentCard.NotHub.selector);
        card.unfreeze();
    }

    function test_returnFunds_byNonHub_reverts() public {
        vm.expectRevert(IAgentCard.NotHub.selector);
        card.returnFunds(address(creditLine));
    }

    function test_freezeUnfreeze_byHub_togglesValidity() public {
        uint256 vb = block.timestamp + 60;
        (bytes memory blob, bytes32 digest) = _blob(ownerPk, payeeA, 1000, 0, vb, keccak256("n9"));

        vm.prank(cardHub);
        card.freeze();
        assertTrue(card.frozen());
        assertEq(card.isValidSignature(digest, blob), INVALID_SIGNATURE);

        vm.prank(cardHub);
        card.unfreeze();
        assertFalse(card.frozen());
        assertEq(card.isValidSignature(digest, blob), MAGICVALUE);
    }

    function test_returnFunds_movesWholeBalance() public {
        usdc.mint(address(card), 777_000);

        vm.expectEmit(true, false, false, true, address(card));
        emit IAgentCard.FundsReturned(address(creditLine), 777_000);

        vm.prank(cardHub);
        card.returnFunds(address(creditLine));

        assertEq(usdc.balanceOf(address(card)), 0);
        assertEq(usdc.balanceOf(address(creditLine)), 777_000);
    }

    function test_returnFunds_zeroBalance_emitsZeroAndDoesNotRevert() public {
        vm.prank(cardHub);
        card.returnFunds(address(creditLine));
        assertEq(usdc.balanceOf(address(creditLine)), 0);
    }

    // -- constructor / getters --

    function test_constructor_emptyPayees_reverts() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(IAgentCard.NoPayees.selector);
        new AgentCard(owner, cardHub, address(usdc), CAP, WINDOW, empty);
    }

    function test_constructor_zeroOwner_reverts() public {
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        vm.expectRevert(IAgentCard.ZeroAddress.selector);
        new AgentCard(address(0), cardHub, address(usdc), CAP, WINDOW, payees);
    }

    function test_constructor_zeroHub_reverts() public {
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        vm.expectRevert(IAgentCard.ZeroAddress.selector);
        new AgentCard(owner, address(0), address(usdc), CAP, WINDOW, payees);
    }

    function test_constructor_zeroUsdc_reverts() public {
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        vm.expectRevert(IAgentCard.ZeroAddress.selector);
        new AgentCard(owner, cardHub, address(0), CAP, WINDOW, payees);
    }

    function test_getters() public view {
        assertEq(card.owner(), owner);
        assertEq(card.hub(), cardHub);
        assertEq(address(card.usdc()), address(usdc));
        assertEq(card.perCallCap(), CAP);
        assertEq(card.maxAuthWindow(), WINDOW);
        assertFalse(card.frozen());
        assertTrue(card.isAllowedPayee(payeeA));
        assertFalse(card.isAllowedPayee(evil));

        address[] memory list = card.payees();
        assertEq(list.length, 1);
        assertEq(list[0], payeeA);
    }

    function test_constructor_zeroPerCallCap_reverts() public {
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        vm.expectRevert(IAgentCard.ZeroPerCallCap.selector);
        new AgentCard(owner, cardHub, address(usdc), 0, WINDOW, payees);
    }

    function test_constructor_zeroMaxAuthWindow_reverts() public {
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        vm.expectRevert(IAgentCard.ZeroMaxAuthWindow.selector);
        new AgentCard(owner, cardHub, address(usdc), CAP, 0, payees);
    }

    function test_constructor_zeroPayee_reverts() public {
        address[] memory payees = new address[](2);
        payees[0] = payeeA;
        payees[1] = address(0);
        vm.expectRevert(IAgentCard.ZeroPayee.selector);
        new AgentCard(owner, cardHub, address(usdc), CAP, WINDOW, payees);
    }

    function test_constructor_duplicatePayee_reverts() public {
        address[] memory payees = new address[](2);
        payees[0] = payeeA;
        payees[1] = payeeA;
        vm.expectRevert(abi.encodeWithSelector(IAgentCard.DuplicatePayee.selector, payeeA));
        new AgentCard(owner, cardHub, address(usdc), CAP, WINDOW, payees);
    }

    // -- fuzz --

    /// `isValidSignature` must never revert, no matter how malformed the inputs, and a
    /// pseudo-random `hash`/`signature` pair can never forge the magic value (an ECDSA forgery
    /// has negligible probability, so this always lands on the invalid selector).
    function testFuzz_isValidSignature_neverRevertsAndRejectsRandomInput(bytes32 hash, bytes calldata signature)
        public
        view
    {
        assertEq(card.isValidSignature(hash, signature), INVALID_SIGNATURE);
    }

    // -- domain name (Base mainnet vs Sepolia) --

    /// Base Sepolia's USDC reports its EIP-712 domain name as "USDC" (mainnet's is "USD Coin").
    /// The card must derive its digest from whatever `DOMAIN_SEPARATOR()` the token actually
    /// returns, not a hardcoded/cached value, so it validates correctly against either.
    function test_isValidSignature_sepoliaStyleDomainName_returnsMagicValue() public {
        MockEIP3009USDC sepoliaUsdc = new MockEIP3009USDC("USDC");
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        AgentCard sepoliaCard = new AgentCard(owner, cardHub, address(sepoliaUsdc), CAP, WINDOW, payees);

        uint256 vb = block.timestamp + 60;
        bytes32 nonce = keccak256("sepolia-n1");
        bytes32 structHash = keccak256(
            abi.encode(
                sepoliaCard.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                address(sepoliaCard),
                payeeA,
                uint256(1000),
                uint256(0),
                vb,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", sepoliaUsdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory blob = abi.encode(abi.encodePacked(r, s, v), payeeA, uint256(1000), uint256(0), vb, nonce);

        assertEq(sepoliaCard.isValidSignature(digest, blob), MAGICVALUE);
    }
}
