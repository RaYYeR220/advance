// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {OracleLib} from "../../src/lib/OracleLib.sol";
import {PoolKey} from "../../src/interfaces/IDopplerFeesManager.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {
    MockCreditLine,
    MockERC20,
    MockFeed,
    MockFeesManager,
    MockHub,
    MockSwapRouter,
    MockWETH
} from "../utils/Mocks.sol";

/// @notice Agent token that refuses transfers sent by one blocked address, either by reverting or
/// by returning false.
contract RevertingToken is MockERC20 {
    enum Mode {
        None,
        Revert,
        ReturnFalse
    }

    Mode public mode;
    address public blockedFrom;

    error TransferBlocked();

    constructor() MockERC20("Reverting Agent", "RAGT", 18) {}

    function setBlocked(address from, Mode mode_) external {
        blockedFrom = from;
        mode = mode_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (msg.sender == blockedFrom) {
            if (mode == Mode.Revert) revert TransferBlocked();
            if (mode == Mode.ReturnFalse) return false;
        }
        return super.transfer(to, value);
    }
}

/// @notice Agent token that, the first time `target` transfers it, calls back into
/// `target.harvest` and records how that re-entrant call reverted, then completes the transfer.
contract ReentrantToken is MockERC20 {
    address public target;
    bool public attempted;
    bytes public reentryRevertData;

    constructor() MockERC20("Reentrant Agent", "REAGT", 18) {}

    function setTarget(address target_) external {
        target = target_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (msg.sender == target && !attempted) {
            attempted = true;
            try RevenueEscrow(payable(target)).harvest(0) {}
            catch (bytes memory reason) {
                reentryRevertData = reason;
            }
        }
        return super.transfer(to, value);
    }
}

/// @notice Unit tests for RevenueEscrow: binding/activation guards, pre-activation forwarding,
/// oracle-bounded swaps and capped distribution, closing and beneficiary hand-back, release on
/// failed/aborted loans, native ETH wrapping, and resilience to hostile agent tokens.
contract RevenueEscrowTest is Test {
    uint256 internal constant LOAN_ID = 42;
    bytes32 internal constant POOL_ID = keccak256("agent-pool");
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ESCROW_SHARES = 0.8e18;
    uint256 internal constant PROTOCOL_SHARES = 0.2e18;
    uint256 internal constant NOTE_SUPPLY = 5e18; // capUsdc = 5_000_000
    uint64 internal constant MAX_STALENESS = 3600;
    uint16 internal constant SLIPPAGE_BPS = 100;
    int256 internal constant ETH_USD = 2400e8;
    uint256 internal constant USDC_PER_WETH = 2400e6;
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant MIN_ACTIVITY_USDC = 1_000_000;

    /// @dev Pool-level WETH fees whose 80% creator share is exactly 1e16 WETH (24 USDC at 2400).
    uint256 internal constant POOL_WETH = 1.25e16;
    /// @dev Pool-level WETH fees whose 80% creator share is exactly 1e15 WETH (2.4 USDC at 2400).
    uint256 internal constant POOL_WETH_SMALL = 1.25e15;
    /// @dev Pool-level agent-token fees whose 80% creator share is exactly 800e18.
    uint256 internal constant POOL_TOKEN = 1000e18;

    MockERC20 internal usdc;
    MockWETH internal weth;
    MockHub internal hub;
    MockSwapRouter internal router;
    MockFeed internal ethUsdFeed;
    MockFeed internal sequencerFeed;
    MockCreditLine internal creditLine;

    MockFeesManager internal fm;
    RevenueNote internal note;
    RevenueEscrow internal escrow;
    /// @dev The pool's non-ETH currency (the agent token).
    address internal token;

    address internal treasury = makeAddr("agentTreasury");
    address internal protocolOwner = makeAddr("protocolOwner");
    address internal auction = makeAddr("auction");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(T0);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockWETH();
        hub = new MockHub();
        creditLine = new MockCreditLine();

        router = new MockSwapRouter();
        router.setRate(USDC_PER_WETH);

        ethUsdFeed = new MockFeed();
        ethUsdFeed.setAnswer(ETH_USD);
        ethUsdFeed.setUpdatedAt(T0);

        sequencerFeed = new MockFeed();
        sequencerFeed.setAnswer(0);
        sequencerFeed.setStartedAt(T0 - 2 hours);

        _deployLoan(address(new MockERC20("Agent", "AGT", 18)), false);
    }

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    /// @dev Registers a fresh pool (agent token + WETH, or + native ETH), deploys the escrow and
    /// note, and onboards the escrow the way production does: the agent treasury moves its
    /// creator shares to the escrow through the fees manager.
    function _deployLoan(address token_, bool nativeEth) internal {
        token = token_;
        address ethLeg = nativeEth ? address(0) : address(weth);
        (address c0, address c1) = ethLeg < token_ ? (ethLeg, token_) : (token_, ethLeg);
        _registerPool(c0, c1);

        escrow = new RevenueEscrow(_config());

        vm.prank(treasury);
        fm.updateBeneficiary(POOL_ID, address(escrow));

        note = new RevenueNote("Advance Note", "ADVN", address(hub), address(usdc));
        vm.startPrank(address(hub));
        note.initialize(address(escrow), address(creditLine));
        note.mint(auction, NOTE_SUPPLY);
        vm.stopPrank();
    }

    function _registerPool(address c0, address c1) internal {
        fm = new MockFeesManager();
        address[] memory beneficiaries = new address[](2);
        beneficiaries[0] = treasury;
        beneficiaries[1] = protocolOwner;
        uint256[] memory shares = new uint256[](2);
        shares[0] = ESCROW_SHARES;
        shares[1] = PROTOCOL_SHARES;
        fm.setPool(
            POOL_ID,
            PoolKey({currency0: c0, currency1: c1, fee: 0x800000, tickSpacing: 200, hooks: address(0xB0B)}),
            beneficiaries,
            shares
        );
    }

    function _config() internal view returns (RevenueEscrow.Config memory) {
        return RevenueEscrow.Config({
            hub: address(hub),
            feesManager: address(fm),
            poolId: POOL_ID,
            treasury: treasury,
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

    function _bind() internal {
        vm.prank(address(hub));
        escrow.bind(LOAN_ID, address(note), address(creditLine));
    }

    function _bindAndActivate() internal {
        _bind();
        creditLine.setState(CreditLine.State.Active);
        vm.prank(address(hub));
        escrow.activate();
    }

    /// @dev Accrues pool-level LP fees (ETH leg as WETH or native ETH, per the pool key) that are
    /// not yet collected by anyone.
    function _accrue(uint256 ethAmount, uint256 tokenAmount) internal {
        PoolKey memory key = fm.getPoolKey(POOL_ID);
        address ethLeg = key.currency0 == token ? key.currency1 : key.currency0;

        vm.deal(address(this), ethAmount);
        uint256 value;
        if (ethLeg == address(0)) {
            value = ethAmount;
        } else {
            weth.deposit{value: ethAmount}();
            weth.approve(address(fm), ethAmount);
        }

        MockERC20(token).mint(address(this), tokenAmount);
        IERC20(token).approve(address(fm), tokenAmount);

        (uint256 amount0, uint256 amount1) =
            key.currency0 == token ? (tokenAmount, ethAmount) : (ethAmount, tokenAmount);
        fm.accrueFees{value: value}(POOL_ID, amount0, amount1);
    }

    function _giveWeth(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        assertTrue(weth.transfer(to, amount));
    }

    function _refreshFeed() internal {
        ethUsdFeed.setUpdatedAt(block.timestamp);
    }

    function _assertPhase(RevenueEscrow.Phase expected) internal view {
        assertEq(uint8(escrow.phase()), uint8(expected));
    }

    function _assertEscrowEmpty() internal view {
        assertEq(weth.balanceOf(address(escrow)), 0, "escrow weth");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow usdc");
        assertEq(IERC20(token).balanceOf(address(escrow)), 0, "escrow token");
    }

    // ---------------------------------------------------------------------------------------
    // constructor / getters
    // ---------------------------------------------------------------------------------------

    function test_constructor_exposesConfig() public view {
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
        assertEq(escrow.activityUsdc(), 0);
        _assertPhase(RevenueEscrow.Phase.Pending);
        assertEq(escrow.loanId(), 0);
        assertEq(address(escrow.note()), address(0));
        assertEq(escrow.creditLine(), address(0));
        assertEq(escrow.lastRevenueAt(), 0);
    }

    function test_constructor_rejectsZeroAddresses() public {
        for (uint256 i; i < 7; ++i) {
            RevenueEscrow.Config memory cfg = _config();
            if (i == 0) cfg.hub = address(0);
            if (i == 1) cfg.feesManager = address(0);
            if (i == 2) cfg.treasury = address(0);
            if (i == 3) cfg.usdc = address(0);
            if (i == 4) cfg.weth = address(0);
            if (i == 5) cfg.router = address(0);
            if (i == 6) cfg.ethUsdFeed = address(0);
            vm.expectRevert(RevenueEscrow.ZeroAddress.selector);
            new RevenueEscrow(cfg);
        }
    }

    function test_constructor_allowsNoSequencerFeed() public {
        RevenueEscrow.Config memory cfg = _config();
        cfg.sequencerFeed = address(0);
        RevenueEscrow deployed = new RevenueEscrow(cfg);
        assertEq(deployed.sequencerFeed(), address(0));
    }

    // ---------------------------------------------------------------------------------------
    // bind
    // ---------------------------------------------------------------------------------------

    function test_bind_setsLoanWiring() public {
        _bind();
        assertEq(escrow.loanId(), LOAN_ID);
        assertEq(address(escrow.note()), address(note));
        assertEq(escrow.creditLine(), address(creditLine));
        _assertPhase(RevenueEscrow.Phase.Pending);
    }

    function test_bind_onlyHub() public {
        vm.prank(keeper);
        vm.expectRevert(RevenueEscrow.NotHub.selector);
        escrow.bind(LOAN_ID, address(note), address(creditLine));
    }

    function test_bind_onlyOnce() public {
        _bind();
        vm.prank(address(hub));
        vm.expectRevert(RevenueEscrow.AlreadyBound.selector);
        escrow.bind(LOAN_ID + 1, address(note), address(creditLine));
    }

    function test_bind_rejectsZeroAddresses() public {
        vm.startPrank(address(hub));
        vm.expectRevert(RevenueEscrow.ZeroAddress.selector);
        escrow.bind(LOAN_ID, address(0), address(creditLine));
        vm.expectRevert(RevenueEscrow.ZeroAddress.selector);
        escrow.bind(LOAN_ID, address(note), address(0));
        vm.stopPrank();
    }

    function test_bind_rejectsNoteDenominatedInAnotherToken() public {
        MockERC20 otherUsdc = new MockERC20("Other USD", "OUSD", 6);
        RevenueNote wrongNote = new RevenueNote("Advance Note", "ADVN", address(hub), address(otherUsdc));

        vm.prank(address(hub));
        vm.expectRevert(RevenueEscrow.InvalidNote.selector);
        escrow.bind(LOAN_ID, address(wrongNote), address(creditLine));
    }

    function test_bind_rejectsPoolWithoutSingleEthLeg() public {
        address tokenA = address(new MockERC20("A", "A", 18));
        address tokenB = address(new MockERC20("B", "B", 18));
        address[4][2] memory badPairs = [
            [tokenA, tokenB, address(weth), address(0)], // no ETH leg; ETH on both legs
            [address(weth), address(usdc), address(0), address(0)] // WETH/USDC; unregistered pool
        ];

        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < 4; j += 2) {
                _registerPool(badPairs[i][j], badPairs[i][j + 1]);
                escrow = new RevenueEscrow(_config());
                vm.prank(address(hub));
                vm.expectRevert(RevenueEscrow.UnsupportedPool.selector);
                escrow.bind(LOAN_ID, address(note), address(creditLine));
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // activate
    // ---------------------------------------------------------------------------------------

    function test_activate_setsActiveAndLastRevenueAt() public {
        _bind();
        creditLine.setState(CreditLine.State.Active);
        vm.warp(T0 + 123);

        vm.prank(address(hub));
        escrow.activate();

        _assertPhase(RevenueEscrow.Phase.Active);
        assertEq(escrow.lastRevenueAt(), T0 + 123);
    }

    function test_activate_onlyHub() public {
        _bind();
        creditLine.setState(CreditLine.State.Active);
        vm.prank(keeper);
        vm.expectRevert(RevenueEscrow.NotHub.selector);
        escrow.activate();
    }

    function test_activate_requiresBind() public {
        creditLine.setState(CreditLine.State.Active);
        vm.prank(address(hub));
        vm.expectRevert(RevenueEscrow.NotBound.selector);
        escrow.activate();
    }

    /// @dev Distributing while the credit line is still Pending would brick its settlement, so
    /// activation must wait until the credit line itself is Active.
    function test_activate_requiresActiveCreditLine() public {
        _bind();
        CreditLine.State[4] memory notActive =
            [CreditLine.State.Pending, CreditLine.State.Frozen, CreditLine.State.Closed, CreditLine.State.Failed];
        for (uint256 i; i < notActive.length; ++i) {
            creditLine.setState(notActive[i]);
            vm.prank(address(hub));
            vm.expectRevert(abi.encodeWithSelector(RevenueEscrow.WrongCreditLineState.selector, notActive[i]));
            escrow.activate();
        }
    }

    function test_activate_onlyOnce() public {
        _bindAndActivate();
        vm.prank(address(hub));
        vm.expectRevert(RevenueEscrow.WrongPhase.selector);
        escrow.activate();
    }

    function test_activate_afterReleaseReverts() public {
        _bind();
        creditLine.setState(CreditLine.State.Failed);
        vm.prank(address(hub));
        escrow.release();

        creditLine.setState(CreditLine.State.Active);
        vm.prank(address(hub));
        vm.expectRevert(RevenueEscrow.WrongPhase.selector);
        escrow.activate();
    }

    // ---------------------------------------------------------------------------------------
    // harvest: before activation
    // ---------------------------------------------------------------------------------------

    function test_harvest_pending_forwardsWethAndTokenToTreasury() public {
        _accrue(POOL_WETH, POOL_TOKEN);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.Forwarded(token, 800e18);
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.Forwarded(address(weth), 1e16);

        vm.prank(keeper);
        uint256 repaid = escrow.harvest(0);

        assertEq(repaid, 0);
        assertEq(weth.balanceOf(treasury), 1e16);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
        assertEq(router.callCount(), 0, "no swap");
        assertEq(note.totalRepaid(), 0, "no distribution");
        assertEq(hub.repaidCallCount(), 0);
        _assertPhase(RevenueEscrow.Phase.Pending);
        _assertEscrowEmpty();
        // Only the caller's share is paid: the protocol owner's share is still in the manager.
        assertEq(weth.balanceOf(address(fm)), POOL_WETH - 1e16);
        assertEq(IERC20(token).balanceOf(address(fm)), POOL_TOKEN - 800e18);
    }

    /// @dev Bound to a loan whose auction is still running: the escrow must not distribute yet.
    function test_harvest_boundButNotActive_neverDistributes() public {
        _bind();
        usdc.mint(address(escrow), 1e6);
        _accrue(POOL_WETH, POOL_TOKEN);

        vm.prank(keeper);
        uint256 repaid = escrow.harvest(0);

        assertEq(repaid, 0);
        assertEq(note.totalRepaid(), 0);
        assertEq(router.callCount(), 0);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(weth.balanceOf(treasury), 1e16);
        _assertEscrowEmpty();
    }

    function test_harvest_pending_needsNoOracle() public {
        _accrue(POOL_WETH, 0);
        vm.warp(T0 + 10 days); // price feed long stale
        sequencerFeed.setAnswer(1); // and the sequencer reported down

        escrow.harvest(0);

        assertEq(weth.balanceOf(treasury), 1e16);
    }

    // ---------------------------------------------------------------------------------------
    // harvest: active
    // ---------------------------------------------------------------------------------------

    function test_harvest_active_reachesCap_overflowToTreasuryAndCloses() public {
        _bindAndActivate();
        _accrue(POOL_WETH, POOL_TOKEN);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.Forwarded(token, 800e18);
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(5e6); // only the distributed part counts
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.Harvested(1e16, 24e6, 5e6, 19e6);
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.BeneficiaryReturned(treasury);

        vm.prank(keeper);
        uint256 repaid = escrow.harvest(0);

        // Swap: all WETH, pool fee 500, into the escrow, bounded by the oracle (24e6 - 1%).
        ISwapRouter02.ExactInputSingleParams memory p = router.last();
        assertEq(router.callCount(), 1);
        assertEq(p.tokenIn, address(weth));
        assertEq(p.tokenOut, address(usdc));
        assertEq(p.fee, 500);
        assertEq(p.recipient, address(escrow));
        assertEq(p.amountIn, 1e16);
        assertEq(p.amountOutMinimum, 23_760_000);
        assertEq(p.sqrtPriceLimitX96, 0);
        assertEq(router.allowanceAtCall(), 1e16, "router approved exactly amountIn");

        // Distribution capped, overflow to treasury.
        assertEq(repaid, 5e6);
        assertEq(note.totalRepaid(), 5e6);
        assertEq(note.remainingCap(), 0);
        assertEq(usdc.balanceOf(address(note)), 5e6);
        assertEq(usdc.balanceOf(treasury), 19e6);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
        _assertEscrowEmpty();

        // Closed, beneficiary shares handed back, hub told once.
        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(fm.getShares(POOL_ID, address(escrow)), 0);
        assertEq(fm.getShares(POOL_ID, treasury), ESCROW_SHARES);
        assertEq(fm.getShares(POOL_ID, protocolOwner), PROTOCOL_SHARES);
        assertEq(hub.repaidCallCount(), 1);
        assertEq(hub.lastRepaidLoanId(), LOAN_ID);
    }

    function test_harvest_afterClose_escrowEarnsNothingAndHubNotCalledAgain() public {
        _bindAndActivate();
        _accrue(POOL_WETH, 0);
        escrow.harvest(0);
        _assertPhase(RevenueEscrow.Phase.Closed);

        _accrue(POOL_WETH, POOL_TOKEN);
        vm.prank(keeper);
        assertEq(escrow.harvest(0), 0);

        assertEq(hub.repaidCallCount(), 1);
        assertEq(router.callCount(), 1);
        assertEq(note.totalRepaid(), 5e6);
        _assertEscrowEmpty();

        // The creator share of post-close fees belongs to the treasury, which collects it itself.
        vm.prank(treasury);
        fm.collectFees(POOL_ID);
        assertEq(weth.balanceOf(treasury), 1e16);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
    }

    function test_harvest_active_belowCap_staysActiveAndStampsRevenue() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(POOL_WETH_SMALL, 0);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(2_400_000);
        vm.prank(keeper);
        uint256 repaid = escrow.harvest(0);

        assertEq(repaid, 2_400_000);
        assertEq(note.totalRepaid(), 2_400_000);
        assertEq(note.remainingCap(), 2_600_000);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(escrow.lastRevenueAt(), T0 + 1 days);
        _assertPhase(RevenueEscrow.Phase.Active);
        assertEq(fm.getShares(POOL_ID, address(escrow)), ESCROW_SHARES);
        assertEq(hub.repaidCallCount(), 0);
        _assertEscrowEmpty();
    }

    function test_harvest_active_noRevenue_keepsLastRevenueAt() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.Harvested(0, 0, 0, 0);
        assertEq(escrow.harvest(0), 0);

        assertEq(escrow.lastRevenueAt(), T0);
        assertEq(router.callCount(), 0);
        _assertPhase(RevenueEscrow.Phase.Active);
    }

    // ---------------------------------------------------------------------------------------
    // harvest: revenue activity (the default timer)
    // ---------------------------------------------------------------------------------------

    function test_activity_usdcDonation_doesNotMoveLastRevenueAt() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);

        usdc.mint(address(escrow), 1);
        assertEq(escrow.harvest(0), 1);
        usdc.mint(address(escrow), 3e6); // even far above the threshold
        assertEq(escrow.harvest(0), 3e6);

        assertEq(note.totalRepaid(), 3e6 + 1, "donations still repay the note");
        assertEq(escrow.lastRevenueAt(), T0);
        assertEq(escrow.activityUsdc(), 0);
    }

    function test_activity_wethDonation_doesNotMoveLastRevenueAt() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _giveWeth(address(escrow), 1e15);

        assertEq(escrow.harvest(0), 2_400_000);

        assertEq(escrow.lastRevenueAt(), T0);
        assertEq(escrow.activityUsdc(), 0);
    }

    function test_activity_donationMixedWithFees_creditsOnlyTheFeeShare() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(POOL_WETH_SMALL / 4, 0); // creator share 2.5e14 WETH
        _giveWeth(address(escrow), 7.5e14); // donation

        assertEq(escrow.harvest(0), 2_400_000);

        // Only the fee-derived quarter of the swap counts: 0.6 USDC, below the 1 USDC threshold.
        assertEq(escrow.activityUsdc(), 600_000);
        assertEq(escrow.lastRevenueAt(), T0);
    }

    function test_activity_smallFeesAccumulateAcrossHarvestsUntilThreshold() public {
        _bindAndActivate();
        // Each round the creator share is 2e14 WETH = 0.48 USDC of fee-derived repayment.
        for (uint256 i = 1; i <= 2; ++i) {
            vm.warp(T0 + i * 1 days);
            _refreshFeed();
            _accrue(2.5e14, 0);
            escrow.harvest(0);
            assertEq(escrow.activityUsdc(), 480_000 * i);
            assertEq(escrow.lastRevenueAt(), T0);
        }

        vm.warp(T0 + 3 days);
        _refreshFeed();
        _accrue(2.5e14, 0);
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(1_440_000);
        escrow.harvest(0);

        assertEq(escrow.lastRevenueAt(), T0 + 3 days);
        assertEq(escrow.activityUsdc(), 0);
        assertEq(note.totalRepaid(), 1_440_000);
    }

    function test_activity_thirdPartyCollectThenHarvest_counts() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(POOL_WETH_SMALL, 0);
        vm.prank(keeper);
        fm.collectFees(POOL_ID); // the escrow's share stays cumulated in the manager

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(2_400_000);
        escrow.harvest(0);

        assertEq(escrow.lastRevenueAt(), T0 + 1 days);
    }

    /// @dev Anyone holding zero shares can call `updateBeneficiary(poolId, escrow)`: the fees
    /// manager then releases the escrow's cumulated fees to it outside any harvest. Those are
    /// still real fees and must still count, or a griefer could force a false default.
    function test_activity_feesPushedOutsideHarvest_stillCount() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(POOL_WETH_SMALL, 0);
        vm.startPrank(keeper);
        fm.collectFees(POOL_ID);
        fm.updateBeneficiary(POOL_ID, address(escrow));
        vm.stopPrank();
        assertEq(weth.balanceOf(address(escrow)), 1e15, "released before the harvest");

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(2_400_000);
        escrow.harvest(0);

        assertEq(escrow.lastRevenueAt(), T0 + 1 days);
        assertEq(fm.getShares(POOL_ID, address(escrow)), ESCROW_SHARES);
    }

    function test_activity_nativeEthPool_counts() public {
        _deployLoan(address(new MockERC20("Agent", "AGT", 18)), true);
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(POOL_WETH_SMALL, 0);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(2_400_000);
        escrow.harvest(0);

        assertEq(escrow.lastRevenueAt(), T0 + 1 days);
    }

    function test_activity_feesBelowSwapMinimum_carryToNextSwap() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(6.25e11, 0); // creator share 5e11 WETH: below MIN_SWAP_WETH, kept
        escrow.harvest(0);
        assertEq(weth.balanceOf(address(escrow)), 5e11);
        assertEq(escrow.activityUsdc(), 0);

        _accrue(POOL_WETH_SMALL, 0);
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(2_401_200); // both rounds' fees count
        escrow.harvest(0);

        assertEq(router.last().amountIn, 1.0005e15);
    }

    /// @dev If another holder moves its shares onto the escrow, the interval spanning that change
    /// is priced at the new share count; the credit must still never exceed the WETH swapped.
    function test_activity_sharesAddedByAnotherHolder_neverCreditMoreThanSwapped() public {
        _bindAndActivate();
        vm.warp(T0 + 1 days);
        _refreshFeed();
        _accrue(POOL_WETH_SMALL, 0);
        vm.prank(keeper);
        fm.collectFees(POOL_ID);
        vm.prank(protocolOwner);
        fm.updateBeneficiary(POOL_ID, address(escrow)); // releases 1e15 WETH to the escrow
        assertEq(fm.getShares(POOL_ID, address(escrow)), WAD);
        usdc.mint(address(escrow), 1e6); // plus a donation

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.LastRevenueAtUpdated(2_400_000);
        assertEq(escrow.harvest(0), 3_400_000);
    }

    function test_activity_feesReleasedBeforeActivation_doNotCount() public {
        _bind();
        _accrue(POOL_WETH, 0);
        escrow.harvest(0); // Pending: forwarded to the treasury
        creditLine.setState(CreditLine.State.Active);
        vm.prank(address(hub));
        escrow.activate();

        vm.warp(T0 + 1 days);
        _refreshFeed();
        _giveWeth(address(escrow), 1e15);
        escrow.harvest(0);

        assertEq(escrow.lastRevenueAt(), T0);
        assertEq(escrow.activityUsdc(), 0);
    }

    function test_harvest_active_afterThirdPartyCollect_stillGetsEscrowShare() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, 0);

        // Anyone can trigger the pool-wide collect, but it only pays the caller's own share.
        vm.prank(keeper);
        fm.collectFees(POOL_ID);
        assertEq(weth.balanceOf(keeper), 0);
        assertEq(weth.balanceOf(address(escrow)), 0);

        escrow.harvest(0);

        assertEq(router.last().amountIn, 1e15);
        assertEq(note.totalRepaid(), 2_400_000);
    }

    function test_harvest_active_dustWeth_skipsSwapAndOracle() public {
        _bindAndActivate();
        _giveWeth(address(escrow), escrow.MIN_SWAP_WETH() - 1);
        vm.warp(T0 + 10 days); // stale feed would revert if it were read

        assertEq(escrow.harvest(0), 0);

        assertEq(router.callCount(), 0);
        assertEq(weth.balanceOf(address(escrow)), escrow.MIN_SWAP_WETH() - 1, "dust kept for later");
    }

    function test_harvest_active_swapsAtMinimumWeth() public {
        _bindAndActivate();
        _giveWeth(address(escrow), escrow.MIN_SWAP_WETH());

        assertEq(escrow.harvest(0), 2400);

        assertEq(router.last().amountIn, 1e12);
        assertEq(router.last().amountOutMinimum, 2376);
    }

    function test_harvest_active_capAlreadyFilled_sendsAllToTreasuryAndCloses() public {
        _bindAndActivate();
        usdc.mint(address(creditLine), 5e6);
        vm.startPrank(address(creditLine));
        usdc.approve(address(note), 5e6);
        note.distribute(5e6);
        vm.stopPrank();
        _accrue(POOL_WETH, 0);

        assertEq(escrow.harvest(0), 0);

        assertEq(usdc.balanceOf(treasury), 24e6);
        assertEq(note.totalRepaid(), 5e6);
        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(hub.repaidCallCount(), 1);
    }

    function test_harvest_nativeEthPool_wrapsFeesAndRepays() public {
        _deployLoan(address(new MockERC20("Agent", "AGT", 18)), true);
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, POOL_TOKEN);

        assertEq(escrow.harvest(0), 2_400_000);

        assertEq(router.last().amountIn, 1e15);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
        assertEq(address(escrow).balance, 0);
        _assertEscrowEmpty();
    }

    function test_harvest_closed_forwardsStrayBalances() public {
        _bind();
        creditLine.setState(CreditLine.State.Failed);
        vm.prank(address(hub));
        escrow.release();

        _giveWeth(address(escrow), 3e15);
        usdc.mint(address(escrow), 7e6);
        MockERC20(token).mint(address(escrow), 5e18);

        assertEq(escrow.harvest(0), 0);

        assertEq(weth.balanceOf(treasury), 3e15);
        assertEq(usdc.balanceOf(treasury), 7e6);
        assertEq(IERC20(token).balanceOf(treasury), 5e18);
        assertEq(note.totalRepaid(), 0);
        _assertEscrowEmpty();
    }

    // ---------------------------------------------------------------------------------------
    // harvest: oracle and swap bounds
    // ---------------------------------------------------------------------------------------

    function test_harvest_staleFeed_revertsAndFeesStayCollectable() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, POOL_TOKEN);
        vm.warp(T0 + MAX_STALENESS + 1);

        vm.expectRevert(OracleLib.StalePrice.selector);
        escrow.harvest(0);

        // The collect rolled back with the rest: fees are still uncollected in the pool.
        PoolKey memory key = fm.getPoolKey(POOL_ID);
        (uint256 ethPending, uint256 tokenPending) = key.currency0 == token
            ? (fm.uncollectedFees1(POOL_ID), fm.uncollectedFees0(POOL_ID))
            : (fm.uncollectedFees0(POOL_ID), fm.uncollectedFees1(POOL_ID));
        assertEq(ethPending, POOL_WETH_SMALL);
        assertEq(tokenPending, POOL_TOKEN);
        assertEq(IERC20(token).balanceOf(treasury), 0);
        _assertEscrowEmpty();

        _refreshFeed();
        assertEq(escrow.harvest(0), 2_400_000);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
    }

    function test_harvest_sequencerDown_reverts() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, 0);
        sequencerFeed.setAnswer(1);

        vm.expectRevert(OracleLib.SequencerDown.selector);
        escrow.harvest(0);
    }

    function test_harvest_keeperMinAboveOracleBound_isHonoured() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, 0);
        router.setRate(2390e6); // 2.39 USDC out: above the 2.376 oracle bound

        vm.expectRevert(MockSwapRouter.TooLittleReceived.selector);
        escrow.harvest(2_395_000);

        assertEq(escrow.harvest(2_390_000), 2_390_000);
        assertEq(router.last().amountOutMinimum, 2_390_000);
    }

    function test_harvest_keeperMinBelowOracleBound_usesOracleBound() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, 0);

        escrow.harvest(1);

        assertEq(router.last().amountOutMinimum, 2_376_000);
    }

    function test_harvest_priceWorseThanOracleBound_reverts() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, 0);
        router.setRate(2300e6); // 2.3 USDC out: below the 2.376 oracle bound

        vm.expectRevert(MockSwapRouter.TooLittleReceived.selector);
        escrow.harvest(0);
    }

    function test_harvest_routerDeliversLessThanMinimum_reverts() public {
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, 0);
        router.setIgnoreMinimum(true);
        router.setDeliverBps(5_000);

        vm.expectRevert(abi.encodeWithSelector(RevenueEscrow.InsufficientOutput.selector, 1_200_000, 2_376_000));
        escrow.harvest(0);
    }

    // ---------------------------------------------------------------------------------------
    // harvest: hostile agent token
    // ---------------------------------------------------------------------------------------

    function test_harvest_revertingAgentToken_emitsForwardFailedAndStillRepays() public {
        RevertingToken bad = new RevertingToken();
        _deployLoan(address(bad), false);
        _bindAndActivate();
        bad.setBlocked(address(escrow), RevertingToken.Mode.Revert);
        _accrue(POOL_WETH_SMALL, POOL_TOKEN);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.ForwardFailed(address(bad), 800e18);
        assertEq(escrow.harvest(0), 2_400_000);

        assertEq(bad.balanceOf(address(escrow)), 800e18, "kept for a retry");
        assertEq(bad.balanceOf(treasury), 0);

        // Once the token lets transfers through again, the next harvest forwards the balance.
        bad.setBlocked(address(0), RevertingToken.Mode.None);
        vm.expectEmit(address(escrow));
        emit RevenueEscrow.Forwarded(address(bad), 800e18);
        escrow.harvest(0);
        assertEq(bad.balanceOf(treasury), 800e18);
    }

    function test_harvest_falseReturningAgentToken_emitsForwardFailed() public {
        RevertingToken bad = new RevertingToken();
        _deployLoan(address(bad), false);
        _bindAndActivate();
        bad.setBlocked(address(escrow), RevertingToken.Mode.ReturnFalse);
        _accrue(POOL_WETH_SMALL, POOL_TOKEN);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.ForwardFailed(address(bad), 800e18);
        assertEq(escrow.harvest(0), 2_400_000);

        assertEq(bad.balanceOf(address(escrow)), 800e18);
    }

    function test_harvest_reentrantAgentToken_innerHarvestRevertsOuterSucceeds() public {
        ReentrantToken evil = new ReentrantToken();
        _deployLoan(address(evil), false);
        evil.setTarget(address(escrow));
        _bindAndActivate();
        _accrue(POOL_WETH_SMALL, POOL_TOKEN);

        uint256 repaid = escrow.harvest(0);

        assertTrue(evil.attempted());
        assertEq(
            evil.reentryRevertData(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(repaid, 2_400_000);
        assertEq(note.totalRepaid(), 2_400_000);
        assertEq(evil.balanceOf(treasury), 800e18);
        assertEq(router.callCount(), 1);
    }

    // ---------------------------------------------------------------------------------------
    // closeIfRepaid
    // ---------------------------------------------------------------------------------------

    function test_closeIfRepaid_afterCreditLineFillsCap_returnsBeneficiary() public {
        _bindAndActivate();
        // Fees pulled into the manager by a third party, never harvested by the escrow.
        _accrue(POOL_WETH, POOL_TOKEN);
        vm.prank(keeper);
        fm.collectFees(POOL_ID);
        // The credit line's freeze fills the whole cap.
        usdc.mint(address(creditLine), 5e6);
        vm.startPrank(address(creditLine));
        usdc.approve(address(note), 5e6);
        note.distribute(5e6);
        vm.stopPrank();
        vm.warp(T0 + 10 days); // closing never needs the oracle

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.BeneficiaryReturned(treasury);
        vm.prank(keeper);
        assertTrue(escrow.closeIfRepaid());

        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(fm.getShares(POOL_ID, address(escrow)), 0);
        assertEq(fm.getShares(POOL_ID, treasury), ESCROW_SHARES);
        assertEq(hub.repaidCallCount(), 1);
        assertEq(hub.lastRepaidLoanId(), LOAN_ID);
        assertEq(router.callCount(), 0);
        // The share released on hand-over reaches the treasury raw.
        assertEq(weth.balanceOf(treasury), 1e16);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
        _assertEscrowEmpty();
    }

    function test_closeIfRepaid_reentrantAgentToken_innerHarvestReverts() public {
        ReentrantToken evil = new ReentrantToken();
        _deployLoan(address(evil), false);
        evil.setTarget(address(escrow));
        _bindAndActivate();
        // The escrow's token share is cumulated in the manager, released to it on hand-over.
        _accrue(0, POOL_TOKEN);
        vm.prank(keeper);
        fm.collectFees(POOL_ID);
        usdc.mint(address(creditLine), 5e6);
        vm.startPrank(address(creditLine));
        usdc.approve(address(note), 5e6);
        note.distribute(5e6);
        vm.stopPrank();

        assertTrue(escrow.closeIfRepaid());

        assertTrue(evil.attempted());
        assertEq(
            evil.reentryRevertData(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(evil.balanceOf(treasury), 800e18);
        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(hub.repaidCallCount(), 1);
    }

    /// @dev The hub calls `closeIfRepaid` unconditionally at the end of `markDefault`, so it must
    /// be a harmless no-op whenever there is nothing to close.
    function test_closeIfRepaid_notActive_isNoOp() public {
        assertFalse(escrow.closeIfRepaid(), "unbound");

        _bind();
        assertFalse(escrow.closeIfRepaid(), "bound, pending");
        _assertPhase(RevenueEscrow.Phase.Pending);

        creditLine.setState(CreditLine.State.Failed);
        vm.prank(address(hub));
        escrow.release();
        assertFalse(escrow.closeIfRepaid(), "released");

        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(hub.repaidCallCount(), 0);
    }

    function test_closeIfRepaid_capRemaining_isNoOp() public {
        _bindAndActivate();
        _accrue(POOL_WETH, POOL_TOKEN);
        vm.prank(keeper);
        fm.collectFees(POOL_ID);

        assertFalse(escrow.closeIfRepaid());

        _assertPhase(RevenueEscrow.Phase.Active);
        assertEq(fm.getShares(POOL_ID, address(escrow)), ESCROW_SHARES);
        (uint256 pending0, uint256 pending1) = fm.pendingInManager(POOL_ID, address(escrow));
        assertGt(pending0 + pending1, 0, "fees still owed to the escrow, not handed over");
        assertEq(hub.repaidCallCount(), 0);
    }

    function test_closeIfRepaid_afterClose_isNoOp() public {
        _bindAndActivate();
        _accrue(POOL_WETH, 0);
        escrow.harvest(0);

        assertFalse(escrow.closeIfRepaid());
        assertEq(hub.repaidCallCount(), 1);
    }

    // ---------------------------------------------------------------------------------------
    // release
    // ---------------------------------------------------------------------------------------

    function test_release_onlyHub() public {
        vm.prank(keeper);
        vm.expectRevert(RevenueEscrow.NotHub.selector);
        escrow.release();
    }

    function test_release_failedLoan_returnsSharesForwardsBalancesAndCloses() public {
        _bind();
        creditLine.setState(CreditLine.State.Failed);
        // Fees already cumulated in the manager by a third party...
        _accrue(POOL_WETH, POOL_TOKEN);
        vm.prank(keeper);
        fm.collectFees(POOL_ID);
        // ...more still uncollected in the pool...
        _accrue(POOL_WETH, POOL_TOKEN);
        // ...and stray balances already on the escrow.
        usdc.mint(address(escrow), 1e6);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.BeneficiaryReturned(treasury);
        vm.prank(address(hub));
        escrow.release();

        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(fm.getShares(POOL_ID, address(escrow)), 0);
        assertEq(fm.getShares(POOL_ID, treasury), ESCROW_SHARES);
        assertEq(weth.balanceOf(treasury), 2e16);
        assertEq(IERC20(token).balanceOf(treasury), 1600e18);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(router.callCount(), 0);
        assertEq(note.totalRepaid(), 0);
        assertEq(hub.repaidCallCount(), 0);
        _assertEscrowEmpty();
    }

    function test_release_abortedLoan_worksUnbound() public {
        _accrue(POOL_WETH, POOL_TOKEN);

        vm.prank(address(hub));
        escrow.release();

        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(fm.getShares(POOL_ID, treasury), ESCROW_SHARES);
        assertEq(weth.balanceOf(treasury), 1e16);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
    }

    function test_release_collectFails_stillReturnsBeneficiary() public {
        _accrue(POOL_WETH, POOL_TOKEN);
        vm.prank(keeper);
        fm.collectFees(POOL_ID); // escrow's share now cumulated in the manager
        fm.setCollectReverts(true);

        vm.expectEmit(address(escrow));
        emit RevenueEscrow.CollectFailed();
        vm.prank(address(hub));
        escrow.release();

        _assertPhase(RevenueEscrow.Phase.Closed);
        assertEq(fm.getShares(POOL_ID, treasury), ESCROW_SHARES);
        // Released by the hand-over itself and forwarded.
        assertEq(weth.balanceOf(treasury), 1e16);
        assertEq(IERC20(token).balanceOf(treasury), 800e18);
        _assertEscrowEmpty();
    }

    function test_release_reentrantAgentToken_innerHarvestReverts() public {
        ReentrantToken evil = new ReentrantToken();
        _deployLoan(address(evil), false);
        evil.setTarget(address(escrow));
        _accrue(POOL_WETH, POOL_TOKEN);

        vm.prank(address(hub));
        escrow.release();

        assertTrue(evil.attempted());
        assertEq(
            evil.reentryRevertData(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(evil.balanceOf(treasury), 800e18);
        assertEq(weth.balanceOf(treasury), 1e16);
        _assertPhase(RevenueEscrow.Phase.Closed);
    }

    function test_release_activeLoan_reverts() public {
        _bindAndActivate();
        vm.prank(address(hub));
        vm.expectRevert(RevenueEscrow.WrongPhase.selector);
        escrow.release();
        assertEq(fm.getShares(POOL_ID, address(escrow)), ESCROW_SHARES);
    }

    function test_release_boundLoanNotFailed_reverts() public {
        _bind();
        CreditLine.State[4] memory notFailed =
            [CreditLine.State.Pending, CreditLine.State.Active, CreditLine.State.Frozen, CreditLine.State.Closed];
        for (uint256 i; i < notFailed.length; ++i) {
            creditLine.setState(notFailed[i]);
            vm.prank(address(hub));
            vm.expectRevert(abi.encodeWithSelector(RevenueEscrow.WrongCreditLineState.selector, notFailed[i]));
            escrow.release();
        }
        assertEq(fm.getShares(POOL_ID, address(escrow)), ESCROW_SHARES);
    }

    function test_release_onlyOnce() public {
        vm.startPrank(address(hub));
        escrow.release();
        vm.expectRevert(RevenueEscrow.WrongPhase.selector);
        escrow.release();
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------
    // receive
    // ---------------------------------------------------------------------------------------

    function test_receive_wrapsEth() public {
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        (bool ok,) = address(escrow).call{value: 1 ether}("");

        assertTrue(ok);
        assertEq(weth.balanceOf(address(escrow)), 1 ether);
        assertEq(address(escrow).balance, 0);
    }

    function test_receive_fromWeth_isNotRewrapped() public {
        vm.deal(address(weth), 1 ether);
        vm.prank(address(weth));
        (bool ok,) = address(escrow).call{value: 1 ether}("");

        assertTrue(ok);
        assertEq(address(escrow).balance, 1 ether);
        assertEq(weth.balanceOf(address(escrow)), 0);
    }
}
