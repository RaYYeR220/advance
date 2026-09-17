// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AdvanceHub} from "../../src/AdvanceHub.sol";
import {AgentCard} from "../../src/AgentCard.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {EscrowDeployer} from "../../src/deployers/EscrowDeployer.sol";
import {LoanDeployer} from "../../src/deployers/LoanDeployer.sol";
import {AuctionParameters, ICCA, ICCAFactory} from "../../src/interfaces/ICCA.sol";
import {IAdvance} from "../../src/interfaces/IAdvance.sol";
import {IAgentCard} from "../../src/interfaces/IAgentCard.sol";
import {IReputationRegistry} from "../../src/interfaces/IERC8004.sol";
import {PoolKey} from "../../src/interfaces/IDopplerFeesManager.sol";
import {TermSheet, TermSheetLib} from "../../src/lib/TermSheetLib.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {TermSheetVector} from "../utils/Vectors.sol";
import {MockAgentCard, MockAuction, MockFeesManager, MockReputation} from "../utils/Mocks.sol";

/// @notice Card stand-in whose getters return arbitrary raw bytes, to show the hub treating any
/// malformed return data as an invalid card rather than reverting some other way.
contract RawReturnCard {
    mapping(bytes4 selector => bytes) internal _returns;

    function setReturn(bytes4 selector, bytes memory data) external {
        _returns[selector] = data;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        bytes memory data = _returns[msg.sig];
        assembly ("memory-safe") {
            return(add(data, 0x20), mload(data))
        }
    }
}

/// @notice A card that passes the hub's checks but, when frozen, harvests the loan's escrow, which
/// can fill the note's cap and close the loan in the middle of `markDefault`.
contract HarvestingCard {
    address public hub;
    address public usdc;
    address public owner;
    address[] internal _payees;
    RevenueEscrow public escrow;
    bool public harvested;

    constructor(address hub_, address usdc_, address owner_, address[] memory payees_) {
        hub = hub_;
        usdc = usdc_;
        owner = owner_;
        _payees = payees_;
    }

    function setEscrow(RevenueEscrow escrow_) external {
        escrow = escrow_;
    }

    function payees() external view returns (address[] memory) {
        return _payees;
    }

    function freeze() external {
        escrow.harvest(0);
        harvested = true;
    }

    function unfreeze() external {}

    function returnFunds(address) external {}
}

/// @notice A card whose hub hooks burn every bit of gas they are given, the way a hostile agent
/// card would to stop its loan from ever being defaulted.
contract GasBurningCard {
    address public hub;
    address public usdc;
    address public owner;
    address[] internal _payees;

    constructor(address hub_, address usdc_, address owner_, address[] memory payees_) {
        hub = hub_;
        usdc = usdc_;
        owner = owner_;
        _payees = payees_;
    }

    function payees() external view returns (address[] memory) {
        return _payees;
    }

    function freeze() external pure {
        _burnGas();
    }

    function unfreeze() external pure {
        _burnGas();
    }

    function returnFunds(address) external pure {
        _burnGas();
    }

    /// @dev `invalid()` consumes all gas forwarded to this call, and nothing else.
    function _burnGas() internal pure {
        assembly ("memory-safe") {
            invalid()
        }
    }
}

/// @notice Unit tests for AdvanceHub against the real RevenueEscrow, RevenueNote, CreditLine and
/// AgentCard, with mocked external dependencies: term-sheet verification and its check order,
/// escrow prediction, loan wiring and auction parameters, the settle/repay/default/abort
/// lifecycle including every optional hook failing, and the owner's lack of power over loans.
contract AdvanceHubTest is BaseTest {
    bytes32 internal constant POOL_ID_2 = keccak256("agent-pool-2");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    function _payees() internal view returns (address[] memory payees) {
        payees = new address[](1);
        payees[0] = payee;
    }

    /// @dev Replaces the fixture hub (and its card) with one built from `cfg`.
    function _redeployHub(AdvanceHub.Config memory cfg) internal {
        hub = new AdvanceHub(cfg, underwriter, owner, escrowDeployer, loanDeployer);
        card = new AgentCard(cardOwner, address(hub), address(usdc), PER_CALL_CAP, MAX_AUTH_WINDOW, _payees());
    }

    /// @dev A card stand-in wired to the fixture hub whose hooks can be made to revert.
    function _mockCard() internal returns (MockAgentCard) {
        return new MockAgentCard(address(hub), address(usdc), cardOwner, _payees());
    }

    function _openLoanAs(address caller, TermSheet memory ts, bytes memory signature) internal returns (uint256) {
        vm.prank(caller);
        return hub.openLoan(ts, signature);
    }

    function _expectOpenRevert(TermSheet memory ts, bytes memory err) internal {
        bytes memory signature = _sign(ts);
        vm.prank(treasury);
        vm.expectRevert(err);
        hub.openLoan(ts, signature);
    }

    function _expectBadTerms(TermSheet memory ts, uint8 code) internal {
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.BadTerms.selector, code));
    }

    function _assertFeedback(uint256 index, int128 value, string memory tag) internal view {
        MockReputation.Feedback memory feedback = reputation.feedbackAt(index);
        assertEq(feedback.client, address(hub), "feedback client");
        assertEq(feedback.agentId, AGENT_ID, "feedback agentId");
        assertEq(feedback.value, value, "feedback value");
        assertEq(feedback.valueDecimals, 0, "feedback decimals");
        assertEq(feedback.tag1, "advance", "feedback tag1");
        assertEq(feedback.tag2, tag, "feedback tag2");
        assertEq(feedback.endpoint, "", "feedback endpoint");
        assertEq(feedback.feedbackURI, "", "feedback uri");
        assertEq(feedback.feedbackHash, MEMO_HASH, "feedback hash");
    }

    // ---------------------------------------------------------------------------------------
    // constructor / config
    // ---------------------------------------------------------------------------------------

    function test_constructor_setsConfigRolesAndDeployers() public view {
        AdvanceHub.Config memory cfg = hub.config();
        assertEq(cfg.usdc, address(usdc));
        assertEq(cfg.weth, address(weth));
        assertEq(cfg.ccaFactory, address(ccaFactory));
        assertEq(cfg.router, address(router));
        assertEq(cfg.ethUsdFeed, address(ethUsdFeed));
        assertEq(cfg.sequencerFeed, address(sequencerFeed));
        assertEq(cfg.reputationRegistry, address(reputation));
        assertEq(cfg.maxStaleness, MAX_STALENESS);
        assertEq(cfg.slippageBps, SLIPPAGE_BPS);
        assertEq(cfg.minActivityUsdc, MIN_ACTIVITY_USDC);

        assertEq(hub.underwriter(), underwriter);
        assertEq(hub.owner(), owner);
        assertEq(hub.pendingOwner(), address(0));
        assertEq(hub.loanCount(), 0);

        assertEq(hub.TICK_SPACING_Q96(), uint256(1e4 << 96) / 1e18);
        assertEq(hub.TICK_SPACING_Q96(), 792281625142643);
        assertEq(hub.CARD_HOOK_GAS(), 200_000);
        assertEq(hub.REPUTATION_HOOK_GAS(), 500_000);
        assertEq(address(hub.escrowDeployer()), address(escrowDeployer));
        assertEq(address(hub.loanDeployer()), address(loanDeployer));

        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) = hub.eip712Domain();
        assertEq(name, "Advance");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(hub));
    }

    function test_constructor_rejectsZeroAddresses() public {
        for (uint256 i; i < 9; ++i) {
            AdvanceHub.Config memory cfg = _hubConfig();
            address underwriter_ = underwriter;
            address owner_ = owner;
            EscrowDeployer escrowDeployer_ = escrowDeployer;
            LoanDeployer loanDeployer_ = loanDeployer;
            if (i == 0) cfg.usdc = address(0);
            if (i == 1) cfg.weth = address(0);
            if (i == 2) cfg.ccaFactory = address(0);
            if (i == 3) cfg.router = address(0);
            if (i == 4) cfg.ethUsdFeed = address(0);
            if (i == 5) underwriter_ = address(0);
            if (i == 6) owner_ = address(0);
            if (i == 7) escrowDeployer_ = EscrowDeployer(address(0));
            if (i == 8) loanDeployer_ = LoanDeployer(address(0));
            vm.expectRevert(AdvanceHub.ZeroAddress.selector);
            new AdvanceHub(cfg, underwriter_, owner_, escrowDeployer_, loanDeployer_);
        }
    }

    function test_constructor_allowsNoSequencerFeedOrRegistry() public {
        AdvanceHub.Config memory cfg = _hubConfig();
        cfg.sequencerFeed = address(0);
        cfg.reputationRegistry = address(0);
        AdvanceHub deployed = new AdvanceHub(cfg, underwriter, owner, escrowDeployer, loanDeployer);
        assertEq(deployed.config().sequencerFeed, address(0));
        assertEq(deployed.config().reputationRegistry, address(0));
    }

    function test_loan_unknownIdIsEmpty() public view {
        AdvanceHub.Loan memory loan = hub.loan(42);
        assertEq(uint8(loan.status), uint8(IAdvance.LoanStatus.None));
        assertEq(loan.escrow, address(0));
        assertEq(loan.creditLine, address(0));
        assertEq(loan.ts.agentTreasury, address(0));
    }

    // ---------------------------------------------------------------------------------------
    // EIP-712 digest
    // ---------------------------------------------------------------------------------------

    function test_termSheetDigest_reproducesCrossLanguageVector() public {
        string memory json = TermSheetVector.read();
        TermSheet memory ts = TermSheetVector.termSheet(json);
        (string memory name, string memory version, uint256 chainId, address verifyingContract) =
            TermSheetVector.domain(json);
        assertEq(name, "Advance");
        assertEq(version, "1");

        vm.chainId(chainId);
        deployCodeTo(
            "AdvanceHub.sol:AdvanceHub",
            abi.encode(_hubConfig(), underwriter, owner, escrowDeployer, loanDeployer),
            verifyingContract
        );

        assertEq(TermSheetLib.structHash(ts), TermSheetVector.structHash(json), "structHash");
        assertEq(AdvanceHub(verifyingContract).termSheetDigest(ts), TermSheetVector.digest(json), "digest");
    }

    function test_termSheetDigest_bindsHubAddressAndChain() public view {
        TermSheet memory ts = _termSheet();
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Advance"), keccak256("1"), block.chainid, address(hub)));
        assertEq(
            hub.termSheetDigest(ts),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, TermSheetLib.structHash(ts)))
        );
    }

    // ---------------------------------------------------------------------------------------
    // escrow prediction / deployment
    // ---------------------------------------------------------------------------------------

    function test_predictEscrow_equalsDeployedEscrow_andDeployIsIdempotent() public {
        TermSheet memory ts = _termSheet();
        address predicted = hub.predictEscrow(ts);
        assertEq(predicted.code.length, 0);

        address deployed = hub.deployEscrow(ts);
        assertEq(deployed, predicted);
        assertGt(deployed.code.length, 0);

        vm.prank(keeper);
        assertEq(hub.deployEscrow(ts), predicted);
    }

    function test_deployEscrow_configComesFromTermSheetAndHub() public {
        TermSheet memory ts = _termSheet();
        RevenueEscrow escrow = RevenueEscrow(payable(hub.deployEscrow(ts)));
        assertEq(escrow.hub(), address(hub));
        assertEq(address(escrow.feesManager()), address(fm));
        assertEq(escrow.poolId(), POOL_ID);
        assertEq(escrow.treasury(), treasury);
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(address(escrow.weth()), address(weth));
        assertEq(address(escrow.router()), address(router));
        assertEq(escrow.ethUsdFeed(), address(ethUsdFeed));
        assertEq(escrow.sequencerFeed(), address(sequencerFeed));
        assertEq(escrow.maxStaleness(), MAX_STALENESS);
        assertEq(escrow.slippageBps(), SLIPPAGE_BPS);
        assertEq(escrow.minActivityUsdc(), MIN_ACTIVITY_USDC);
    }

    function test_predictEscrow_isSaltedByTheWholeTermSheet() public view {
        TermSheet memory ts = _termSheet();
        address base = hub.predictEscrow(ts);

        TermSheet memory other = _termSheet(2);
        assertTrue(hub.predictEscrow(other) != base, "nonce");

        other = _termSheet();
        other.memoHash = keccak256("other-evidence");
        assertTrue(hub.predictEscrow(other) != base, "memoHash");

        other = _termSheet();
        other.drawLimit = DRAW_LIMIT + 1;
        assertTrue(hub.predictEscrow(other) != base, "drawLimit");
    }

    function test_predictEscrow_isTheEscrowDeployersCreate2Address() public view {
        TermSheet memory ts = _termSheet();
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(RevenueEscrow).creationCode, abi.encode(_escrowConfigFor(ts))));
        assertEq(hub.predictEscrow(ts), vm.computeCreate2Address(_hash(ts), initCodeHash, address(escrowDeployer)));
        assertEq(hub.predictEscrow(ts), escrowDeployer.predict(_escrowConfigFor(ts), _hash(ts)));
    }

    function test_deployers_areOrdinaryContractsCalledByTheHub() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory signature = _sign(ts);

        vm.startStateDiffRecording();
        uint256 loanId = _openLoanAs(treasury, ts, signature);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        (VmSafe.AccountAccessKind[] memory kinds,,) = _accessesFrom(accesses, address(hub));
        for (uint256 i; i < kinds.length; ++i) {
            assertTrue(kinds[i] != VmSafe.AccountAccessKind.DelegateCall, "hub never delegatecalls a deployer");
            assertTrue(kinds[i] != VmSafe.AccountAccessKind.Create, "the deployers create, not the hub");
        }

        // The deployers hand control of everything they create to the hub that called them.
        AdvanceHub.Loan memory loan = hub.loan(loanId);
        assertEq(RevenueNote(loan.note).hub(), address(hub));
        assertEq(CreditLine(loan.creditLine).hub(), address(hub));
        assertEq(RevenueEscrow(payable(loan.escrow)).hub(), address(hub));
    }

    function test_escrowDeployer_rejectsAConfigNamingAnotherHub() public {
        TermSheet memory ts = _termSheet();
        RevenueEscrow.Config memory cfg = _escrowConfigFor(ts);
        cfg.hub = keeper;
        vm.prank(keeper);
        escrowDeployer.deploy(cfg, _hash(ts)); // the caller may deploy its own escrow

        vm.prank(keeper);
        vm.expectRevert(EscrowDeployer.NotHub.selector);
        escrowDeployer.deploy(_escrowConfigFor(ts), _hash(ts)); // but not one naming the hub
    }

    function test_loanDeployer_recordsItsCallerAsHub() public {
        RevenueNote note = RevenueNote(loanDeployer.deployNote(7, address(usdc)));
        assertEq(note.hub(), address(this));
        assertEq(note.name(), "Advance Revenue Note #7");

        CreditLine creditLine =
            CreditLine(loanDeployer.deployCreditLine(address(usdc), address(card), treasury, DRAW_LIMIT, DRAW_PERIOD));
        assertEq(creditLine.hub(), address(this));
    }

    function _escrowConfigFor(TermSheet memory ts) internal view returns (RevenueEscrow.Config memory) {
        return RevenueEscrow.Config({
            hub: address(hub),
            feesManager: ts.feesManager,
            poolId: ts.poolId,
            treasury: ts.agentTreasury,
            usdc: address(usdc),
            weth: address(weth),
            router: address(router),
            ethUsdFeed: address(ethUsdFeed),
            sequencerFeed: address(sequencerFeed),
            maxStaleness: MAX_STALENESS,
            slippageBps: SLIPPAGE_BPS,
            minActivityUsdc: MIN_ACTIVITY_USDC
        });
    }

    // ---------------------------------------------------------------------------------------
    // openLoan: reverts
    // ---------------------------------------------------------------------------------------

    function test_openLoan_revertsNotBorrower() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory signature = _sign(ts);
        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotBorrower.selector);
        hub.openLoan(ts, signature);
    }

    function test_openLoan_revertsExpired() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        vm.warp(uint256(ts.deadline) + 1);
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.Expired.selector));
    }

    function test_openLoan_succeedsAtDeadline() public {
        TermSheet memory ts = _termSheet();
        vm.warp(ts.deadline);
        assertEq(_open(ts), 1);
    }

    function test_openLoan_revertsNonceUsed_forAnotherTermSheetWithTheSameNonce() public {
        _open();
        TermSheet memory ts = _termSheet();
        ts.memoHash = keccak256("other-evidence");
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.NonceUsed.selector));
    }

    function test_openLoan_revertsAlreadyOpened_forTheSameTermSheetTwice() public {
        TermSheet memory ts = _termSheet();
        _open(ts);
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.AlreadyOpened.selector));
    }

    function test_openLoan_revertsBadSignature_wrongKey() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory signature = _signWith(0xB0B, ts);
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.BadSignature.selector);
        hub.openLoan(ts, signature);
    }

    function test_openLoan_revertsBadSignature_signedForDifferentTerms() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        TermSheet memory signed = _termSheet();
        signed.drawLimit = DRAW_LIMIT * 10;
        bytes memory signature = _sign(signed);
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.BadSignature.selector);
        hub.openLoan(ts, signature);
    }

    function test_openLoan_revertsBadSignature_malformed() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory signature = _sign(ts);

        bytes memory truncated = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            truncated[i] = signature[i];
        }
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.BadSignature.selector);
        hub.openLoan(ts, truncated);

        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.BadSignature.selector);
        hub.openLoan(ts, "");
    }

    function test_openLoan_revertsBadTerms_1_auctionBlocks() public {
        uint64[3] memory bad = [uint64(0), 3, 30_000];
        for (uint256 i; i < bad.length; ++i) {
            TermSheet memory ts = _termSheet();
            ts.auctionBlocks = bad[i];
            _expectBadTerms(ts, 1);
        }
    }

    function test_openLoan_revertsBadTerms_2_floorCents() public {
        uint16[3] memory bad = [uint16(0), 101, type(uint16).max];
        for (uint256 i; i < bad.length; ++i) {
            TermSheet memory ts = _termSheet();
            ts.floorCents = bad[i];
            _expectBadTerms(ts, 2);
        }
    }

    function test_openLoan_revertsBadTerms_3_noteSupply() public {
        uint256[3] memory bad = [uint256(0), 1e18 - 1e12, NOTE_SUPPLY + 1];
        for (uint256 i; i < bad.length; ++i) {
            TermSheet memory ts = _termSheet();
            ts.noteSupply = bad[i];
            ts.minPrincipal = 1;
            _expectBadTerms(ts, 3);
        }
    }

    function test_openLoan_revertsBadTerms_4_minPrincipal() public {
        TermSheet memory ts = _termSheet();
        ts.minPrincipal = 0;
        _expectBadTerms(ts, 4);

        // Max raise at the floor: 5 notes * 80c = 4 USDC.
        ts = _termSheet();
        ts.minPrincipal = 4e6 + 1;
        _expectBadTerms(ts, 4);

        // Rounds down: 1.000001 notes * 80c = 0.8000008 USDC -> 800_000 USDC-wei.
        ts = _termSheet();
        ts.noteSupply = 1.000001e18;
        ts.minPrincipal = 800_001;
        _expectBadTerms(ts, 4);
    }

    function test_openLoan_revertsBadTerms_5_drawAndGrace() public {
        TermSheet memory ts = _termSheet();
        ts.drawLimit = 0;
        _expectBadTerms(ts, 5);

        ts = _termSheet();
        ts.drawPeriod = 0;
        _expectBadTerms(ts, 5);

        ts = _termSheet();
        ts.gracePeriod = 0;
        _expectBadTerms(ts, 5);
    }

    function test_openLoan_revertsBadTerms_6_expectedShares() public {
        TermSheet memory ts = _termSheet();
        ts.expectedShares = 0;
        _expectBadTerms(ts, 6);
    }

    function test_openLoan_acceptsBoundaryTerms() public {
        TermSheet memory ts = _termSheet();
        ts.auctionBlocks = 1e7;
        ts.floorCents = 100;
        ts.noteSupply = 1e18;
        ts.minPrincipal = 1e6;
        ts.drawLimit = 1;
        ts.drawPeriod = 1;
        ts.gracePeriod = 1;
        uint256 loanId = _open(ts);

        AuctionParameters memory params = ccaFactory.lastParams();
        assertEq(params.endBlock - params.startBlock, 1e7);
        assertEq(params.auctionStepsData, abi.encodePacked(uint24(1), uint40(1e7)));
        assertEq(params.floorPrice, 100 * hub.TICK_SPACING_Q96());
        _assertStatus(loanId, IAdvance.LoanStatus.Auction);

        ts = _termSheet(2);
        ts.poolId = POOL_ID_2;
        ts.auctionBlocks = 1;
        ts.agentCard = address(_mockCard());
        _registerSecondPool();
        _open(ts);
        params = ccaFactory.lastParams();
        assertEq(params.endBlock, params.startBlock + 1);
        assertEq(params.auctionStepsData, abi.encodePacked(uint24(1e7), uint40(1)));
    }

    function test_openLoan_revertsNotWethPool() public {
        _registerPool(address(usdc), address(agentToken));
        _expectOpenRevert(_termSheet(), abi.encodeWithSelector(AdvanceHub.NotWethPool.selector));

        // v1 underwrites WETH-paired pools only, not native-ETH ones.
        _registerPool(address(0), address(agentToken));
        _expectOpenRevert(_termSheet(), abi.encodeWithSelector(AdvanceHub.NotWethPool.selector));
    }

    function test_openLoan_revertsUnsupportedPool() public {
        // Native ETH against WETH: no agent token to forward at all.
        _registerPool(address(0), address(weth));
        _expectOpenRevert(_termSheet(), abi.encodeWithSelector(AdvanceHub.UnsupportedPool.selector, address(0)));

        // USDC against WETH: the escrow's repayment token cannot also be the agent leg.
        _registerPool(address(usdc), address(weth));
        _expectOpenRevert(_termSheet(), abi.encodeWithSelector(AdvanceHub.UnsupportedPool.selector, address(usdc)));

        // An agent leg with no code can never be forwarded to the treasury.
        address ghost = makeAddr("ghostToken");
        _registerPool(ghost, address(weth));
        _expectOpenRevert(_termSheet(), abi.encodeWithSelector(AdvanceHub.UnsupportedPool.selector, ghost));
    }

    function test_openLoan_acceptsWethAsEitherCurrency() public {
        address highToken = address(type(uint160).max);
        address lowToken = address(0x1010);
        vm.etch(highToken, address(agentToken).code);
        vm.etch(lowToken, address(agentToken).code);

        _registerPool(address(weth), highToken);
        assertEq(fm.getPoolKey(POOL_ID).currency0, address(weth));
        assertEq(_open(), 1);

        _registerSecondPoolWith(lowToken);
        assertEq(fm.getPoolKey(POOL_ID_2).currency1, address(weth));
        TermSheet memory ts = _termSheet(2);
        ts.poolId = POOL_ID_2;
        ts.agentCard = address(_mockCard());
        assertEq(_open(ts), 2);
    }

    function test_openLoan_revertsInvalidCard() public {
        address[] memory noPayees = new address[](0);
        address[7] memory cards = [
            makeAddr("eoaCard"),
            address(usdc),
            address(new MockAgentCard(address(0xBEEF), address(usdc), cardOwner, _payees())),
            address(new MockAgentCard(address(hub), address(weth), cardOwner, _payees())),
            address(new MockAgentCard(address(hub), address(usdc), cardOwner, noPayees)),
            address(new MockAgentCard(address(hub), address(usdc), address(0), _payees())),
            address(new AgentCard(cardOwner, address(0xBEEF), address(usdc), PER_CALL_CAP, MAX_AUTH_WINDOW, _payees()))
        ];
        for (uint256 i; i < cards.length; ++i) {
            TermSheet memory ts = _termSheet();
            ts.agentCard = cards[i];
            _onboardFresh(ts);
            _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.InvalidCard.selector));
        }
    }

    function test_openLoan_revertsInvalidCard_onMalformedReturnData() public {
        bytes memory hubWord = abi.encode(address(hub));
        bytes memory usdcWord = abi.encode(address(usdc));
        bytes memory ownerWord = abi.encode(cardOwner);
        bytes memory payeesData = abi.encode(_payees());

        for (uint256 i; i < 7; ++i) {
            RawReturnCard raw = new RawReturnCard();
            raw.setReturn(IAgentCard.hub.selector, hubWord);
            raw.setReturn(IAgentCard.usdc.selector, usdcWord);
            raw.setReturn(IAgentCard.owner.selector, ownerWord);
            raw.setReturn(IAgentCard.payees.selector, payeesData);

            // Well-formed getters are accepted up to the share check.
            if (i == 0) {
                TermSheet memory valid = _termSheet();
                valid.agentCard = address(raw);
                _expectOpenRevert(
                    valid, abi.encodeWithSelector(AdvanceHub.EscrowNotBeneficiary.selector, 0, CREATOR_SHARES)
                );
                continue;
            }
            if (i == 1) raw.setReturn(IAgentCard.hub.selector, "");
            if (i == 2) raw.setReturn(IAgentCard.usdc.selector, new bytes(31));
            if (i == 3) {
                raw.setReturn(IAgentCard.hub.selector, abi.encode(uint256(uint160(address(hub))) | (1 << 200)));
            }
            if (i == 4) raw.setReturn(IAgentCard.owner.selector, abi.encode(uint256(1) << 160));
            if (i == 5) raw.setReturn(IAgentCard.payees.selector, abi.encode(type(uint256).max, uint256(1)));
            if (i == 6) raw.setReturn(IAgentCard.payees.selector, abi.encode(uint256(0x20)));

            TermSheet memory ts = _termSheet();
            ts.agentCard = address(raw);
            _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.InvalidCard.selector));
        }
    }

    function test_openLoan_revertsCardInUse_whileAnotherLoanIsLive() public {
        uint256 first = _open();
        assertEq(hub.liveLoanOf(address(card)), first);

        _registerSecondPool();
        TermSheet memory ts = _termSheet(2);
        ts.poolId = POOL_ID_2;
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.CardInUse.selector, first));

        // Still in use once the loan is active, and once it has defaulted.
        _settle(first, 3e6, true);
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.CardInUse.selector, first));
        _warpPastGrace(first);
        hub.markDefault(first);
        _assertStatus(first, IAdvance.LoanStatus.Defaulted);
        vm.warp(T0); // back inside the second term sheet's deadline
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.CardInUse.selector, first));
    }

    function test_openLoan_freesTheCardOnceTheLoanIsRepaid() public {
        uint256 first = _openActive(3e6);
        _repay(first, CAP_USDC);
        _assertStatus(first, IAdvance.LoanStatus.Repaid);
        assertEq(hub.liveLoanOf(address(card)), 0);

        _registerSecondPool();
        TermSheet memory ts = _termSheet(2);
        ts.poolId = POOL_ID_2;
        uint256 second = _open(ts);
        assertEq(second, 2);
        assertEq(hub.liveLoanOf(address(card)), second);
    }

    function test_openLoan_freesTheCardOnceTheAuctionFails() public {
        uint256 first = _open();
        _settle(first, 0, false);
        _assertStatus(first, IAdvance.LoanStatus.Failed);
        assertEq(hub.liveLoanOf(address(card)), 0);

        TermSheet memory ts = _termSheet(2);
        _onboard(ts);
        assertEq(_open(ts), 2);
    }

    function test_openLoan_revertsAlreadyOpened_evenAfterUnderwriterRotation() public {
        TermSheet memory ts = _termSheet();
        _open(ts);

        uint256 newKey = 0xC0FFEE;
        vm.prank(owner);
        hub.setUnderwriter(vm.addr(newKey));

        bytes memory signature = _signWith(newKey, ts);
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.AlreadyOpened.selector);
        hub.openLoan(ts, signature);
    }

    function test_openLoan_revertsEscrowNotBeneficiary_whenNotOnboarded() public {
        _expectOpenRevert(
            _termSheet(), abi.encodeWithSelector(AdvanceHub.EscrowNotBeneficiary.selector, 0, CREATOR_SHARES)
        );
    }

    function test_openLoan_revertsEscrowNotBeneficiary_whenSharesBelowExpected() public {
        TermSheet memory ts = _termSheet();
        ts.expectedShares = CREATOR_SHARES + 1;
        _onboard(ts);
        _expectOpenRevert(
            ts, abi.encodeWithSelector(AdvanceHub.EscrowNotBeneficiary.selector, CREATOR_SHARES, CREATOR_SHARES + 1)
        );
    }

    /// @dev One term sheet failing every check, repaired one check at a time, proves the order:
    /// borrower, deadline, nonce, signature, terms, pool, card, escrow shares.
    function test_openLoan_checksRunInOrder() public {
        _open(); // uses nonce 1 and moves the treasury's shares into its escrow

        MockFeesManager otherFm = new MockFeesManager();
        otherFm.setPool(
            POOL_ID,
            PoolKey({
                currency0: address(usdc), currency1: address(agentToken), fee: 0, tickSpacing: 1, hooks: address(0)
            }),
            new address[](0),
            new uint256[](0)
        );

        TermSheet memory ts = _termSheet(1);
        ts.auctionBlocks = 3;
        ts.feesManager = address(otherFm);
        ts.agentCard = makeAddr("eoaCard");
        bytes memory wrongKeySig = _signWith(0xB0B, ts);

        vm.warp(uint256(ts.deadline) + 1);
        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotBorrower.selector);
        hub.openLoan(ts, wrongKeySig);

        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.Expired.selector);
        hub.openLoan(ts, wrongKeySig);

        vm.warp(T0);
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.NonceUsed.selector);
        hub.openLoan(ts, wrongKeySig);

        ts.nonce = 2;
        wrongKeySig = _signWith(0xB0B, ts);
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.BadSignature.selector);
        hub.openLoan(ts, wrongKeySig);

        _expectBadTerms(ts, 1);

        ts.auctionBlocks = AUCTION_BLOCKS;
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.NotWethPool.selector));

        ts.feesManager = address(fm);
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.InvalidCard.selector));

        ts.agentCard = address(card);
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.CardInUse.selector, 1));

        ts.agentCard = address(_mockCard());
        _expectOpenRevert(ts, abi.encodeWithSelector(AdvanceHub.EscrowNotBeneficiary.selector, 0, CREATOR_SHARES));
    }

    // ---------------------------------------------------------------------------------------
    // openLoan: success
    // ---------------------------------------------------------------------------------------

    function test_openLoan_deploysWiresAndRecordsLoan() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory signature = _sign(ts);
        address predicted = hub.predictEscrow(ts);

        vm.recordLogs();
        uint256 loanId = _openLoanAs(treasury, ts, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (address evEscrow, address evNote, address evCreditLine, address evAuction) = _loanOpenedEvent(logs, loanId, ts);

        AdvanceHub.Loan memory loan = hub.loan(loanId);
        assertEq(loanId, 1);
        assertEq(hub.loanCount(), 1);
        assertEq(hub.loanIdOf(_hash(ts)), 1);
        assertTrue(hub.nonceUsed(underwriter, ts.nonce));

        assertEq(loan.escrow, predicted, "escrow == predicted");
        assertEq(loan.escrow, evEscrow, "escrow == event");
        assertEq(loan.note, evNote, "note == event");
        assertEq(loan.creditLine, evCreditLine, "creditLine == event");
        assertEq(loan.auction, evAuction, "auction == event");
        assertEq(_hash(loan.ts), _hash(ts), "stored term sheet");
        assertEq(uint8(loan.status), uint8(IAdvance.LoanStatus.Auction));
        assertEq(loan.openedAt, T0);
        assertEq(loan.activatedAt, 0);

        RevenueEscrow escrow = RevenueEscrow(payable(loan.escrow));
        assertEq(escrow.loanId(), loanId);
        assertEq(address(escrow.note()), loan.note);
        assertEq(escrow.creditLine(), loan.creditLine);
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Pending));
        assertEq(fm.getShares(POOL_ID, loan.escrow), CREATOR_SHARES);

        RevenueNote note = RevenueNote(loan.note);
        assertEq(note.name(), "Advance Revenue Note #1");
        assertEq(note.symbol(), "arN1");
        assertEq(note.hub(), address(hub));
        assertEq(address(note.usdc()), address(usdc));
        assertEq(note.escrow(), loan.escrow);
        assertEq(note.creditLine(), loan.creditLine);
        assertEq(note.auction(), loan.auction);
        assertEq(note.totalSupply(), NOTE_SUPPLY);
        assertEq(note.balanceOf(loan.auction), NOTE_SUPPLY);

        CreditLine creditLine = CreditLine(loan.creditLine);
        assertEq(creditLine.hub(), address(hub));
        assertEq(address(creditLine.usdc()), address(usdc));
        assertEq(creditLine.card(), address(card));
        assertEq(creditLine.treasury(), treasury);
        assertEq(creditLine.drawLimit(), DRAW_LIMIT);
        assertEq(creditLine.drawPeriod(), DRAW_PERIOD);
        assertEq(creditLine.loanId(), loanId);
        assertEq(address(creditLine.auction()), loan.auction);
        assertEq(address(creditLine.note()), loan.note);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Pending));

        MockAuction auction = MockAuction(loan.auction);
        assertEq(auction.tokensReceivedCalls(), 1, "onTokensReceived called once");
        assertEq(auction.balanceAtTokensReceived(), NOTE_SUPPLY, "supply held before onTokensReceived");
        assertEq(auction.currency(), address(usdc));
        assertEq(auction.token(), loan.note);
        assertEq(auction.fundsRecipient(), loan.creditLine);
        assertEq(auction.tokensRecipient(), loan.creditLine);
    }

    function _loanOpenedEvent(Vm.Log[] memory logs, uint256 loanId, TermSheet memory ts)
        internal
        view
        returns (address escrow, address note, address creditLine, address auction)
    {
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hub) || logs[i].topics[0] != AdvanceHub.LoanOpened.selector) continue;
            found++;
            assertEq(uint256(logs[i].topics[1]), loanId, "event loanId");
            assertEq(logs[i].topics[2], _hash(ts), "event termSheetHash");
            assertEq(address(uint160(uint256(logs[i].topics[3]))), ts.agentTreasury, "event treasury");
            (escrow, note, creditLine, auction) = abi.decode(logs[i].data, (address, address, address, address));
        }
        assertEq(found, 1, "one LoanOpened");
    }

    function test_openLoan_createsAuctionWithTermSheetParameters() public {
        uint256 loanId = _open();
        AdvanceHub.Loan memory loan = hub.loan(loanId);
        AuctionParameters memory params = ccaFactory.lastParams();
        uint256 tick = hub.TICK_SPACING_Q96();

        assertEq(ccaFactory.createCount(), 1);
        assertEq(ccaFactory.lastToken(), loan.note);
        assertEq(ccaFactory.lastAmount(), NOTE_SUPPLY);
        assertEq(ccaFactory.lastSalt(), bytes32(loanId));
        assertEq(ccaFactory.lastSender(), address(hub));

        assertEq(params.currency, address(usdc));
        assertEq(params.tokensRecipient, loan.creditLine);
        assertEq(params.fundsRecipient, loan.creditLine);
        assertEq(params.startBlock, START_BLOCK + 1);
        assertEq(params.endBlock, START_BLOCK + 1 + AUCTION_BLOCKS);
        assertEq(params.claimBlock, params.endBlock);
        assertEq(params.tickSpacing, tick);
        assertEq(params.validationHook, address(0));
        assertEq(params.floorPrice, FLOOR_CENTS * tick);
        assertEq(params.requiredCurrencyRaised, MIN_PRINCIPAL);
        assertEq(params.auctionStepsData, abi.encodePacked(uint24(20_000), uint40(AUCTION_BLOCKS)));
        assertEq(MockAuction(loan.auction).endBlock(), params.endBlock);
    }

    function test_openLoan_callOrder() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory signature = _sign(ts);

        vm.startStateDiffRecording();
        uint256 loanId = _openLoanAs(treasury, ts, signature);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        AdvanceHub.Loan memory loan = hub.loan(loanId);
        (address[] memory targets, bytes4[] memory selectors) = _callsFrom(accesses, address(hub));

        address[9] memory expectedTargets = [
            address(escrowDeployer),
            address(loanDeployer),
            address(loanDeployer),
            address(ccaFactory),
            loan.note,
            loan.auction,
            loan.creditLine,
            loan.note,
            loan.escrow
        ];
        bytes4[9] memory expectedSelectors = [
            EscrowDeployer.deploy.selector,
            LoanDeployer.deployCreditLine.selector,
            LoanDeployer.deployNote.selector,
            ICCAFactory.create.selector,
            RevenueNote.mint.selector,
            ICCA.onTokensReceived.selector,
            CreditLine.initialize.selector,
            RevenueNote.initialize.selector,
            RevenueEscrow.bind.selector
        ];
        assertEq(targets.length, expectedTargets.length, "call count");
        for (uint256 i; i < expectedTargets.length; ++i) {
            assertEq(targets[i], expectedTargets[i], "call target");
            assertEq(selectors[i], expectedSelectors[i], "call selector");
        }
    }

    function test_openLoan_secondLoanGetsNextIdAndItsOwnContracts() public {
        uint256 first = _open();
        _registerSecondPool();
        TermSheet memory ts = _termSheet(2);
        ts.poolId = POOL_ID_2;
        ts.agentCard = address(_mockCard());
        uint256 second = _open(ts);

        assertEq(second, 2);
        assertEq(hub.loanCount(), 2);
        assertEq(hub.loanIdOf(_hash(ts)), 2);
        assertEq(ccaFactory.lastSalt(), bytes32(uint256(2)));
        assertEq(_note(second).name(), "Advance Revenue Note #2");
        assertEq(_note(second).symbol(), "arN2");
        assertTrue(hub.loan(first).escrow != hub.loan(second).escrow);
        assertTrue(hub.loan(first).note != hub.loan(second).note);
        assertTrue(hub.loan(first).creditLine != hub.loan(second).creditLine);
        assertTrue(hub.loan(first).auction != hub.loan(second).auction);
    }

    function _registerSecondPool() internal {
        _registerSecondPoolWith(address(agentToken));
    }

    function _registerSecondPoolWith(address token) internal {
        (address c0, address c1) = address(weth) < token ? (address(weth), token) : (token, address(weth));
        address[] memory beneficiaries = new address[](1);
        beneficiaries[0] = treasury;
        uint256[] memory shares = new uint256[](1);
        shares[0] = CREATOR_SHARES;
        fm.setPool(
            POOL_ID_2,
            PoolKey({currency0: c0, currency1: c1, fee: 0x800000, tickSpacing: 200, hooks: address(0xB0B)}),
            beneficiaries,
            shares
        );
    }

    /// @dev Gives the treasury fresh creator shares in `POOL_ID` and onboards `ts`'s escrow with
    /// them, so each iteration of a loop starts onboarded.
    function _onboardFresh(TermSheet memory ts) internal {
        _registerPool(address(weth), address(agentToken));
        _onboard(ts);
    }

    // ---------------------------------------------------------------------------------------
    // onAuctionSettled
    // ---------------------------------------------------------------------------------------

    function test_onAuctionSettled_revertsForAnyCallerButTheLoansCreditLine() public {
        uint256 loanId = _open();
        AdvanceHub.Loan memory loan = hub.loan(loanId);
        address[4] memory callers = [keeper, loan.escrow, loan.note, loan.auction];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(AdvanceHub.NotLoanContract.selector);
            hub.onAuctionSettled(loanId, true);
        }

        vm.prank(loan.creditLine);
        vm.expectRevert(AdvanceHub.NotLoanContract.selector);
        hub.onAuctionSettled(loanId + 1, true);
    }

    function test_onAuctionSettled_graduatedActivatesLoanAndEscrow() public {
        uint256 loanId = _open();
        vm.warp(T0 + 10 minutes);

        CreditLine creditLine = _prepareSettle(loanId, 3e6, true);
        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanActivated(loanId, 3e6);
        creditLine.settleAuction();

        _assertStatus(loanId, IAdvance.LoanStatus.Active);
        assertEq(hub.loan(loanId).activatedAt, T0 + 10 minutes);
        assertEq(uint8(_escrow(loanId).phase()), uint8(RevenueEscrow.Phase.Active));
        assertEq(_escrow(loanId).lastRevenueAt(), T0 + 10 minutes);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active));
        assertEq(creditLine.principal(), 3e6);
    }

    function test_onAuctionSettled_notGraduatedFailsAndReleasesEscrow() public {
        uint256 loanId = _open();
        RevenueEscrow escrow = _escrow(loanId);

        CreditLine creditLine = _prepareSettle(loanId, 0, false);
        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanFailed(loanId);
        creditLine.settleAuction();

        _assertStatus(loanId, IAdvance.LoanStatus.Failed);
        assertEq(hub.loan(loanId).activatedAt, 0);
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Closed));
        assertEq(fm.getShares(POOL_ID, address(escrow)), 0);
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Failed));
        assertEq(_note(loanId).totalSupply(), 0);
    }

    function test_onAuctionSettled_graduatedRevertsIfEscrowHoldsNoShares() public {
        uint256 loanId = _open();
        address[] memory beneficiaries = new address[](1);
        beneficiaries[0] = address(_escrow(loanId));
        uint256[] memory shares = new uint256[](1);
        fm.setPool(POOL_ID, fm.getPoolKey(POOL_ID), beneficiaries, shares);

        MockAuction auction = _auction(loanId);
        usdc.mint(address(auction), 3e6);
        auction.recordSale(lender, NOTE_SUPPLY);
        auction.setGraduated(true);
        vm.roll(auction.endBlock());

        CreditLine creditLine = _creditLine(loanId);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.EscrowNotBeneficiary.selector, 0, 1));
        creditLine.settleAuction();
    }

    function test_onAuctionSettled_revertsUnlessLoanIsInAuction() public {
        uint256 loanId = _openActive(3e6);
        vm.prank(address(_creditLine(loanId)));
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Active));
        hub.onAuctionSettled(loanId, true);
    }

    function test_onAuctionSettled_neverCallsBackIntoTheCreditLine() public {
        for (uint256 i; i < 2; ++i) {
            bool graduated = i == 0;
            TermSheet memory ts = _termSheet(i + 1);
            if (!graduated) {
                _registerSecondPool();
                ts.poolId = POOL_ID_2;
                ts.agentCard = address(_mockCard());
            }
            uint256 loanId = _open(ts);
            MockAuction auction = _auction(loanId);
            if (graduated) {
                usdc.mint(address(auction), 3e6);
                auction.recordSale(lender, NOTE_SUPPLY);
            }
            auction.setGraduated(graduated);
            vm.roll(auction.endBlock());

            vm.startStateDiffRecording();
            _creditLine(loanId).settleAuction();
            Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

            (address[] memory targets, bytes4[] memory selectors) = _callsFrom(accesses, address(hub));
            assertEq(targets.length, 1, "hub makes exactly one call");
            assertEq(targets[0], address(_escrow(loanId)));
            assertEq(selectors[0], graduated ? RevenueEscrow.activate.selector : RevenueEscrow.release.selector);
        }
    }

    // ---------------------------------------------------------------------------------------
    // onRepaid
    // ---------------------------------------------------------------------------------------

    function test_onRepaid_revertsForAnyCallerButTheLoansEscrow() public {
        uint256 loanId = _openActive(3e6);
        AdvanceHub.Loan memory loan = hub.loan(loanId);
        address[3] memory callers = [keeper, loan.creditLine, loan.note];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(AdvanceHub.NotLoanContract.selector);
            hub.onRepaid(loanId);
        }

        vm.prank(loan.escrow);
        vm.expectRevert(AdvanceHub.NotLoanContract.selector);
        hub.onRepaid(loanId + 1);
    }

    function test_onRepaid_revertsUnlessActiveOrDefaulted() public {
        uint256 loanId = _open();
        vm.prank(hub.loan(loanId).escrow);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Auction));
        hub.onRepaid(loanId);
    }

    function test_onRepaid_fromActive_closesCreditLineAndPostsFeedback() public {
        uint256 loanId = _openActive(3e6);
        _draw(loanId, 100_000);
        RevenueEscrow escrow = _escrow(loanId);
        CreditLine creditLine = _creditLine(loanId);

        _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanRepaid(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.ReputationPosted(loanId, AGENT_ID, 100, "repaid");
        vm.prank(keeper);
        escrow.harvest(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Closed));
        assertEq(usdc.balanceOf(address(creditLine)), 0);
        assertEq(usdc.balanceOf(treasury), 3e6 - 100_000, "undrawn principal to treasury");
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Closed));
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES, "beneficiary returned");
        assertEq(_note(loanId).totalRepaid(), CAP_USDC);
        assertFalse(card.frozen());
        assertEq(usdc.balanceOf(address(card)), 100_000, "card keeps its funds");

        assertEq(reputation.feedbackCount(), 1);
        _assertFeedback(0, 100, "repaid");
    }

    function test_onRepaid_fromDefaulted_keepsFrozenCreditLineAndUnfreezesCard() public {
        uint256 loanId = _openActive(3e6);
        _draw(loanId, 200_000);
        _warpPastGrace(loanId);
        hub.markDefault(loanId);
        assertTrue(card.frozen());
        assertEq(_note(loanId).totalRepaid(), 3e6, "principal and card funds to notes");

        CreditLine creditLine = _creditLine(loanId);
        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC - 3e6);
        vm.expectCall(address(creditLine), abi.encodeCall(CreditLine.close, ()), 0);
        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanRepaid(loanId, CAP_USDC);
        vm.prank(keeper);
        escrow.harvest(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Frozen));
        assertFalse(card.frozen());
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES);
        assertEq(reputation.feedbackCount(), 2);
        _assertFeedback(0, -100, "default");
        _assertFeedback(1, 100, "repaid");
    }

    function test_onRepaid_reputationFailureIsSkipped() public {
        uint256 loanId = _openActive(3e6);
        reputation.setReverts(true);

        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.ReputationSkipped(loanId, abi.encodeWithSelector(MockReputation.FeedbackRejected.selector));
        vm.prank(keeper);
        escrow.harvest(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Closed));
        assertEq(reputation.feedbackCount(), 0);
    }

    function test_onRepaid_noAgentIdSkipsReputation() public {
        TermSheet memory ts = _termSheet();
        ts.agentId = 0;
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);

        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.ReputationSkipped(loanId, "");
        vm.prank(keeper);
        escrow.harvest(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(reputation.feedbackCount(), 0);
    }

    function test_onRepaid_registryWithoutCodeSkipsReputation() public {
        AdvanceHub.Config memory cfg = _hubConfig();
        cfg.reputationRegistry = makeAddr("registryWithoutCode");
        _redeployHub(cfg);
        uint256 loanId = _openActive(3e6);

        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.ReputationSkipped(loanId, "");
        vm.prank(keeper);
        escrow.harvest(0);
        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
    }

    function test_onRepaid_revertingCardHookIsSkipped() public {
        MockAgentCard mockCard = _mockCard();
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(mockCard);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        mockCard.setHooksRevert(true);

        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.unfreeze.selector);
        vm.prank(keeper);
        escrow.harvest(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(reputation.feedbackCount(), 1);
    }

    function test_onRepaid_callsCardUnfreeze() public {
        MockAgentCard mockCard = _mockCard();
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(mockCard);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);

        _repay(loanId, CAP_USDC);
        assertEq(mockCard.unfreezeCalls(), 1);
        assertEq(mockCard.freezeCalls(), 0);
        assertEq(mockCard.returnFundsCalls(), 0, "card funds stay with the agent");
    }

    function test_onRepaid_cardWithoutCodeIsSkipped() public {
        uint256 loanId = _openActive(3e6);
        vm.etch(address(card), "");

        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.unfreeze.selector);
        vm.prank(keeper);
        escrow.harvest(0);
        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
    }

    function test_onRepaid_creditLineCloseFailureIsSwallowed() public {
        uint256 loanId = _openActive(3e6);
        CreditLine creditLine = _creditLine(loanId);
        vm.mockCallRevert(address(creditLine), abi.encodeCall(CreditLine.close, ()), "close failed");

        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        vm.expectEmit(address(hub));
        emit AdvanceHub.CloseAttemptFailed(loanId, address(creditLine), "close failed");
        vm.prank(keeper);
        escrow.harvest(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(uint8(_escrow(loanId).phase()), uint8(RevenueEscrow.Phase.Closed));
        assertEq(_note(loanId).totalRepaid(), CAP_USDC, "final repayment still lands");
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES);
    }

    // ---------------------------------------------------------------------------------------
    // markDefault
    // ---------------------------------------------------------------------------------------

    function test_markDefault_revertsUnlessActive() public {
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.None));
        hub.markDefault(1);

        uint256 loanId = _open();
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Auction));
        hub.markDefault(loanId);

        _settle(loanId, 0, false);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Failed));
        hub.markDefault(loanId);
    }

    function test_markDefault_revertsOnceDefaultedOrRepaid() public {
        uint256 loanId = _openActive(3e6);
        _warpPastGrace(loanId);
        hub.markDefault(loanId);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Defaulted));
        hub.markDefault(loanId);

        _repay(loanId, CAP_USDC - 3e6);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Repaid));
        hub.markDefault(loanId);
    }

    function test_markDefault_revertsNotDelinquentUntilGraceHasPassed() public {
        uint256 loanId = _openActive(3e6);
        uint64 eligibleAt = _escrow(loanId).lastRevenueAt() + GRACE_PERIOD;

        vm.warp(eligibleAt);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.NotDelinquent.selector, eligibleAt));
        hub.markDefault(loanId);

        vm.warp(uint256(eligibleAt) + 1);
        hub.markDefault(loanId);
        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
    }

    function test_markDefault_freezesCardReturnsFundsFreezesCreditLineAndPostsFeedback() public {
        uint256 loanId = _openActive(3e6);
        _draw(loanId, DRAW_LIMIT);
        uint64 lastRevenueAt = _escrow(loanId).lastRevenueAt();
        _warpPastGrace(loanId);
        CreditLine creditLine = _creditLine(loanId);

        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanDefaulted(loanId, lastRevenueAt);
        vm.expectEmit(address(hub));
        emit AdvanceHub.ReputationPosted(loanId, AGENT_ID, -100, "default");
        vm.prank(keeper);
        hub.markDefault(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertTrue(card.frozen(), "card frozen");
        assertEq(usdc.balanceOf(address(card)), 0, "card funds returned");
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Frozen));
        assertEq(usdc.balanceOf(address(creditLine)), 0, "nothing stranded in the credit line");
        assertEq(_note(loanId).totalRepaid(), 3e6, "undrawn principal plus card funds to notes");
        assertEq(uint8(_escrow(loanId).phase()), uint8(RevenueEscrow.Phase.Active), "escrow keeps repaying");
        assertEq(reputation.feedbackCount(), 1);
        _assertFeedback(0, -100, "default");
    }

    function test_markDefault_callOrder() public {
        uint256 loanId = _openActive(3e6);
        _warpPastGrace(loanId);
        AdvanceHub.Loan memory loan = hub.loan(loanId);

        vm.startStateDiffRecording();
        hub.markDefault(loanId);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        (address[] memory targets, bytes4[] memory selectors) = _callsFrom(accesses, address(hub));
        address[5] memory expectedTargets =
            [address(card), address(card), address(reputation), loan.creditLine, loan.escrow];
        bytes4[5] memory expectedSelectors = [
            IAgentCard.freeze.selector,
            IAgentCard.returnFunds.selector,
            IReputationRegistry.giveFeedback.selector,
            CreditLine.freeze.selector,
            RevenueEscrow.closeIfRepaid.selector
        ];
        assertEq(targets.length, expectedTargets.length, "call count");
        for (uint256 i; i < expectedTargets.length; ++i) {
            assertEq(targets[i], expectedTargets[i], "call target");
            assertEq(selectors[i], expectedSelectors[i], "call selector");
        }
    }

    function test_markDefault_cardWithoutCodeIsSkipped() public {
        uint256 loanId = _openActive(3e6);
        _warpPastGrace(loanId);
        vm.etch(address(card), "");

        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.freeze.selector);
        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.returnFunds.selector);
        hub.markDefault(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
        assertEq(_note(loanId).totalRepaid(), 3e6);
    }

    function test_markDefault_revertingCardHooksAreSkipped() public {
        MockAgentCard mockCard = _mockCard();
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(mockCard);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        _warpPastGrace(loanId);
        mockCard.setHooksRevert(true);

        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.freeze.selector);
        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.returnFunds.selector);
        hub.markDefault(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
    }

    function test_markDefault_callsBothCardHooksOnAContractCard() public {
        MockAgentCard mockCard = _mockCard();
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(mockCard);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        _warpPastGrace(loanId);

        vm.expectCall(address(mockCard), abi.encodeCall(IAgentCard.returnFunds, (hub.loan(loanId).creditLine)));
        hub.markDefault(loanId);
        assertEq(mockCard.freezeCalls(), 1);
        assertEq(mockCard.returnFundsCalls(), 1);
    }

    function test_markDefault_cardCannotRepayFromInsideItsHook() public {
        HarvestingCard hostile = new HarvestingCard(address(hub), address(usdc), cardOwner, _payees());
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(hostile);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        _warpPastGrace(loanId);
        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);
        hostile.setEscrow(escrow);

        // The hook tries to harvest the escrow, which costs far more than `CARD_HOOK_GAS`, so it
        // runs out of its stipend and is skipped; the default is unaffected.
        vm.expectEmit(address(hub));
        emit AdvanceHub.CardHookSkipped(loanId, IAgentCard.freeze.selector);
        hub.markDefault(loanId);

        assertFalse(hostile.harvested(), "the hook could not finish its harvest");
        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
        assertEq(reputation.feedbackCount(), 1);
        _assertFeedback(0, -100, "default");

        // The escrow's USDC still repays noteholders on the next harvest.
        vm.prank(keeper);
        escrow.harvest(0);
        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(_note(loanId).totalRepaid(), CAP_USDC);
    }

    function test_markDefault_gasBurningCardCannotBlockTheDefault() public {
        GasBurningCard hostile = new GasBurningCard(address(hub), address(usdc), cardOwner, _payees());
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(hostile);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        _warpPastGrace(loanId);

        // A realistic transaction gas budget: both hooks burn their whole stipend and the rest of
        // the default still has to fit.
        vm.prank(keeper);
        hub.markDefault{gas: 1_000_000}(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
        assertEq(_note(loanId).totalRepaid(), 3e6, "undrawn principal still reaches noteholders");
        assertEq(reputation.feedbackCount(), 1);
        _assertFeedback(0, -100, "default");
    }

    function test_onRepaid_gasBurningCardCannotBlockRepayment() public {
        GasBurningCard hostile = new GasBurningCard(address(hub), address(usdc), cardOwner, _payees());
        TermSheet memory ts = _termSheet();
        ts.agentCard = address(hostile);
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        RevenueEscrow escrow = _fundEscrow(loanId, CAP_USDC);

        vm.prank(keeper);
        escrow.harvest{gas: 2_000_000}(0);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(_note(loanId).totalRepaid(), CAP_USDC);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Closed));
        assertEq(reputation.feedbackCount(), 1);
        _assertFeedback(0, 100, "repaid");
    }

    function test_markDefault_gasBurningRegistryCannotBlockTheDefault() public {
        uint256 loanId = _openActive(3e6);
        _warpPastGrace(loanId);
        reputation.setBurnsGas(true);

        vm.prank(keeper);
        hub.markDefault{gas: 1_500_000}(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
        assertEq(_note(loanId).totalRepaid(), 3e6, "undrawn principal still reaches noteholders");
        assertEq(reputation.feedbackCount(), 0);
    }

    function test_markDefault_reputationFailureIsSkipped() public {
        uint256 loanId = _openActive(3e6);
        _warpPastGrace(loanId);
        reputation.setReverts(true);

        vm.expectEmit(address(hub));
        emit AdvanceHub.ReputationSkipped(loanId, abi.encodeWithSelector(MockReputation.FeedbackRejected.selector));
        hub.markDefault(loanId);
        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
    }

    function test_markDefault_whenFreezeFillsTheCap_endsRepaid() public {
        uint256 loanId = _openActive(CAP_USDC);
        _warpPastGrace(loanId);
        RevenueEscrow escrow = _escrow(loanId);

        uint64 lastRevenueAt = escrow.lastRevenueAt();
        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanDefaulted(loanId, lastRevenueAt);
        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanRepaid(loanId, CAP_USDC);
        hub.markDefault(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Closed));
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES);
        assertFalse(card.frozen(), "unfrozen once repaid");
        assertEq(reputation.feedbackCount(), 2);
        _assertFeedback(0, -100, "default");
        _assertFeedback(1, 100, "repaid");
    }

    function test_markDefault_closeIfRepaidFailureIsSwallowed() public {
        uint256 loanId = _openActive(CAP_USDC);
        _warpPastGrace(loanId);
        RevenueEscrow escrow = _escrow(loanId);
        fm.setUpdateBeneficiaryReverts(true);

        vm.expectEmit(address(hub));
        emit AdvanceHub.CloseAttemptFailed(
            loanId, address(escrow), abi.encodeWithSelector(MockFeesManager.NativeTransferFailed.selector)
        );
        hub.markDefault(loanId);

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(_creditLine(loanId).state()), uint8(CreditLine.State.Frozen));
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Active));
        assertEq(_note(loanId).totalRepaid(), CAP_USDC);
    }

    // ---------------------------------------------------------------------------------------
    // abort
    // ---------------------------------------------------------------------------------------

    function test_abort_revertsUntilDeadlineHasPassed() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        vm.expectRevert(AdvanceHub.NotExpired.selector);
        hub.abort(ts);

        vm.warp(ts.deadline);
        vm.expectRevert(AdvanceHub.NotExpired.selector);
        hub.abort(ts);
    }

    function test_abort_afterDeadline_deploysEscrowAndReturnsBeneficiary() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        address predicted = hub.predictEscrow(ts);
        assertEq(predicted.code.length, 0);
        vm.warp(uint256(ts.deadline) + 1);

        vm.expectEmit(address(hub));
        emit AdvanceHub.LoanAborted(_hash(ts));
        vm.prank(keeper);
        hub.abort(ts);

        assertGt(predicted.code.length, 0);
        assertEq(uint8(RevenueEscrow(payable(predicted)).phase()), uint8(RevenueEscrow.Phase.Closed));
        assertEq(fm.getShares(POOL_ID, predicted), 0);
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES);
        assertEq(hub.loanCount(), 0);
    }

    function test_abort_worksOnAnAlreadyDeployedEscrow() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        hub.deployEscrow(ts);
        vm.warp(uint256(ts.deadline) + 1);
        hub.abort(ts);
        assertEq(fm.getShares(POOL_ID, treasury), CREATOR_SHARES);
    }

    function test_abort_revertsForAnOpenedLoan() public {
        TermSheet memory ts = _termSheet();
        _open(ts);
        vm.expectRevert(AdvanceHub.AlreadyOpened.selector);
        hub.abort(ts);

        vm.warp(uint256(ts.deadline) + 1);
        vm.expectRevert(AdvanceHub.AlreadyOpened.selector);
        hub.abort(ts);
    }

    function test_abort_twiceRevertsWithAHubError() public {
        TermSheet memory ts = _termSheet();
        _onboard(ts);
        vm.warp(uint256(ts.deadline) + 1);
        hub.abort(ts);
        vm.expectRevert(AdvanceHub.AlreadyAborted.selector);
        hub.abort(ts);
    }

    function test_termSheetStatus_reportsAbortedAndLoanStatuses() public {
        TermSheet memory aborting = _termSheet();
        assertEq(uint8(hub.termSheetStatus(_hash(aborting))), uint8(IAdvance.LoanStatus.None));

        _onboard(aborting);
        vm.warp(uint256(aborting.deadline) + 1);
        hub.abort(aborting);
        assertTrue(hub.aborted(_hash(aborting)));
        assertEq(uint8(hub.termSheetStatus(_hash(aborting))), uint8(IAdvance.LoanStatus.Aborted));

        vm.warp(T0);
        TermSheet memory opening = _termSheet(2);
        uint256 loanId = _open(opening);
        assertEq(uint8(hub.termSheetStatus(_hash(opening))), uint8(IAdvance.LoanStatus.Auction));
        _settle(loanId, 3e6, true);
        assertEq(uint8(hub.termSheetStatus(_hash(opening))), uint8(IAdvance.LoanStatus.Active));
    }

    // ---------------------------------------------------------------------------------------
    // ownership / underwriter
    // ---------------------------------------------------------------------------------------

    function test_setUnderwriter_onlyOwner() public {
        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotOwner.selector);
        hub.setUnderwriter(keeper);
    }

    function test_setUnderwriter_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(AdvanceHub.ZeroAddress.selector);
        hub.setUnderwriter(address(0));
    }

    function test_setUnderwriter_rotatesTheAcceptedSigner() public {
        uint256 newKey = 0xC0FFEE;
        address newUnderwriter = vm.addr(newKey);

        vm.expectEmit(address(hub));
        emit AdvanceHub.UnderwriterUpdated(underwriter, newUnderwriter);
        vm.prank(owner);
        hub.setUnderwriter(newUnderwriter);
        assertEq(hub.underwriter(), newUnderwriter);

        TermSheet memory ts = _termSheet();
        _onboard(ts);
        bytes memory oldSignature = _sign(ts);
        vm.prank(treasury);
        vm.expectRevert(AdvanceHub.BadSignature.selector);
        hub.openLoan(ts, oldSignature);

        assertEq(_openLoanAs(treasury, ts, _signWith(newKey, ts)), 1);
        assertTrue(hub.nonceUsed(newUnderwriter, ts.nonce));
        assertFalse(hub.nonceUsed(underwriter, ts.nonce));
    }

    function test_ownership_isTwoStep() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotOwner.selector);
        hub.transferOwnership(newOwner);

        vm.expectEmit(address(hub));
        emit AdvanceHub.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        hub.transferOwnership(newOwner);
        assertEq(hub.owner(), owner);
        assertEq(hub.pendingOwner(), newOwner);

        vm.prank(keeper);
        vm.expectRevert(AdvanceHub.NotPendingOwner.selector);
        hub.acceptOwnership();

        vm.expectEmit(address(hub));
        emit AdvanceHub.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        hub.acceptOwnership();
        assertEq(hub.owner(), newOwner);
        assertEq(hub.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(AdvanceHub.NotOwner.selector);
        hub.setUnderwriter(keeper);

        vm.prank(newOwner);
        hub.setUnderwriter(keeper);
        assertEq(hub.underwriter(), keeper);
    }

    function test_owner_hasNoPowerOverLoansOrTheirFunds() public {
        TermSheet memory ts = _termSheet();
        uint256 loanId = _open(ts);
        _settle(loanId, 3e6, true);
        AdvanceHub.Loan memory loan = hub.loan(loanId);
        uint256 creditLineUsdc = usdc.balanceOf(loan.creditLine);
        bytes memory signature = _sign(ts);

        vm.startPrank(owner);
        vm.expectRevert(AdvanceHub.NotLoanContract.selector);
        hub.onAuctionSettled(loanId, false);
        vm.expectRevert(AdvanceHub.NotLoanContract.selector);
        hub.onRepaid(loanId);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.NotDelinquent.selector, loan.activatedAt + GRACE_PERIOD));
        hub.markDefault(loanId);
        vm.expectRevert(AdvanceHub.AlreadyOpened.selector);
        hub.abort(ts);
        vm.expectRevert(AdvanceHub.NotBorrower.selector);
        hub.openLoan(ts, signature);
        assertEq(hub.deployEscrow(ts), loan.escrow);
        hub.setUnderwriter(keeper);
        vm.stopPrank();

        assertEq(usdc.balanceOf(loan.creditLine), creditLineUsdc);
        assertEq(fm.getShares(POOL_ID, loan.escrow), CREATOR_SHARES);
        _assertStatus(loanId, IAdvance.LoanStatus.Active);

        // The loan runs to completion under its original terms regardless of the rotation.
        _repay(loanId, CAP_USDC);
        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
    }
}
