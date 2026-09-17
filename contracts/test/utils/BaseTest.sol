// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AdvanceHub} from "../../src/AdvanceHub.sol";
import {AgentCard} from "../../src/AgentCard.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {IAdvance} from "../../src/interfaces/IAdvance.sol";
import {PoolKey} from "../../src/interfaces/IDopplerFeesManager.sol";
import {TermSheet, TermSheetLib} from "../../src/lib/TermSheetLib.sol";
import {
    MockAuction,
    MockCCAFactory,
    MockERC20,
    MockFeed,
    MockFeesManager,
    MockReputation,
    MockSwapRouter,
    MockWETH
} from "./Mocks.sol";

/// @notice Shared offline fixture for AdvanceHub tests: mocks for every external dependency
/// (USDC, WETH, Doppler fees manager, CCA factory, swap router, Chainlink feeds, ERC-8004
/// reputation registry), a hub wired to them, a real AgentCard bound to that hub, and helpers to
/// sign, onboard, open, settle, draw on and repay loans the way production does.
abstract contract BaseTest is Test {
    uint256 internal constant UNDERWRITER_KEY = 0xA11CE;
    bytes32 internal constant POOL_ID = keccak256("agent-pool");
    uint256 internal constant CREATOR_SHARES = 0.95e18;
    uint256 internal constant PROTOCOL_SHARES = 0.05e18;

    uint256 internal constant AGENT_ID = 88336;
    uint256 internal constant NOTE_SUPPLY = 5e18; // cap 5 USDC
    uint256 internal constant CAP_USDC = 5e6;
    uint16 internal constant FLOOR_CENTS = 80;
    uint128 internal constant MIN_PRINCIPAL = 2e6;
    uint64 internal constant AUCTION_BLOCKS = 500;
    uint128 internal constant DRAW_LIMIT = 250_000;
    uint64 internal constant DRAW_PERIOD = 1 days;
    uint64 internal constant GRACE_PERIOD = 14 days;
    bytes32 internal constant MEMO_HASH = keccak256("evidence-bundle");

    uint64 internal constant MAX_STALENESS = 3600;
    uint16 internal constant SLIPPAGE_BPS = 100;
    uint256 internal constant MIN_ACTIVITY_USDC = 1_000_000;
    int256 internal constant ETH_USD = 2400e8;

    uint256 internal constant PER_CALL_CAP = 50_000;
    uint64 internal constant MAX_AUTH_WINDOW = 300;

    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant START_BLOCK = 1000;

    MockERC20 internal usdc;
    MockWETH internal weth;
    MockERC20 internal agentToken;
    MockFeesManager internal fm;
    MockCCAFactory internal ccaFactory;
    MockSwapRouter internal router;
    MockFeed internal ethUsdFeed;
    MockFeed internal sequencerFeed;
    MockReputation internal reputation;

    AdvanceHub internal hub;
    AgentCard internal card;

    address internal underwriter;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("agentTreasury");
    address internal cardOwner = makeAddr("cardOwner");
    address internal payee = makeAddr("payee");
    address internal protocolOwner = makeAddr("protocolOwner");
    address internal lender = makeAddr("lender");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(START_BLOCK);

        underwriter = vm.addr(UNDERWRITER_KEY);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockWETH();
        agentToken = new MockERC20("Agent", "AGT", 18);
        fm = new MockFeesManager();
        ccaFactory = new MockCCAFactory();
        router = new MockSwapRouter();
        reputation = new MockReputation();

        ethUsdFeed = new MockFeed();
        ethUsdFeed.setAnswer(ETH_USD);
        ethUsdFeed.setUpdatedAt(T0);
        sequencerFeed = new MockFeed();
        sequencerFeed.setAnswer(0);
        sequencerFeed.setStartedAt(T0 - 2 hours);

        _registerPool(address(weth), address(agentToken));

        hub = new AdvanceHub(_hubConfig(), underwriter, owner);

        address[] memory payees = new address[](1);
        payees[0] = payee;
        card = new AgentCard(cardOwner, address(hub), address(usdc), PER_CALL_CAP, MAX_AUTH_WINDOW, payees);
    }

    // ---------------------------------------------------------------------------------------
    // fixture builders
    // ---------------------------------------------------------------------------------------

    function _hubConfig() internal view returns (AdvanceHub.Config memory) {
        return AdvanceHub.Config({
            usdc: address(usdc),
            weth: address(weth),
            ccaFactory: address(ccaFactory),
            router: address(router),
            ethUsdFeed: address(ethUsdFeed),
            sequencerFeed: address(sequencerFeed),
            reputationRegistry: address(reputation),
            maxStaleness: MAX_STALENESS,
            slippageBps: SLIPPAGE_BPS,
            minActivityUsdc: MIN_ACTIVITY_USDC
        });
    }

    /// @dev Registers `POOL_ID` pairing `legA` and `legB` (sorted), with the agent treasury as the
    /// creator beneficiary and a protocol owner holding the rest.
    function _registerPool(address legA, address legB) internal {
        (address c0, address c1) = legA < legB ? (legA, legB) : (legB, legA);
        address[] memory beneficiaries = new address[](2);
        beneficiaries[0] = treasury;
        beneficiaries[1] = protocolOwner;
        uint256[] memory shares = new uint256[](2);
        shares[0] = CREATOR_SHARES;
        shares[1] = PROTOCOL_SHARES;
        fm.setPool(
            POOL_ID,
            PoolKey({currency0: c0, currency1: c1, fee: 0x800000, tickSpacing: 200, hooks: address(0xB0B)}),
            beneficiaries,
            shares
        );
    }

    /// @dev A valid term sheet for the fixture pool and card, with the given nonce.
    function _termSheet(uint256 nonce) internal view returns (TermSheet memory) {
        return TermSheet({
            agentTreasury: treasury,
            agentCard: address(card),
            agentId: AGENT_ID,
            feesManager: address(fm),
            poolId: POOL_ID,
            expectedShares: CREATOR_SHARES,
            noteSupply: NOTE_SUPPLY,
            floorCents: FLOOR_CENTS,
            minPrincipal: MIN_PRINCIPAL,
            auctionBlocks: AUCTION_BLOCKS,
            drawLimit: DRAW_LIMIT,
            drawPeriod: DRAW_PERIOD,
            gracePeriod: GRACE_PERIOD,
            deadline: uint64(T0 + 1 hours),
            nonce: nonce,
            memoHash: MEMO_HASH
        });
    }

    function _termSheet() internal view returns (TermSheet memory) {
        return _termSheet(1);
    }

    function _sign(TermSheet memory ts) internal view returns (bytes memory) {
        return _signWith(UNDERWRITER_KEY, ts);
    }

    function _signWith(uint256 key, TermSheet memory ts) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hub.termSheetDigest(ts));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------------------------------
    // lifecycle helpers
    // ---------------------------------------------------------------------------------------

    /// @dev The agent treasury moves its creator shares to the term sheet's predicted escrow.
    function _onboard(TermSheet memory ts) internal {
        address escrow = hub.predictEscrow(ts);
        vm.prank(treasury);
        fm.updateBeneficiary(ts.poolId, escrow);
    }

    /// @dev Onboards, signs and opens `ts` from the agent treasury.
    function _open(TermSheet memory ts) internal returns (uint256 loanId) {
        _onboard(ts);
        bytes memory signature = _sign(ts);
        vm.prank(treasury);
        loanId = hub.openLoan(ts, signature);
    }

    function _open() internal returns (uint256 loanId) {
        return _open(_termSheet());
    }

    function _loan(uint256 loanId) internal view returns (AdvanceHub.Loan memory) {
        return hub.loan(loanId);
    }

    function _escrow(uint256 loanId) internal view returns (RevenueEscrow) {
        return RevenueEscrow(payable(hub.loan(loanId).escrow));
    }

    function _note(uint256 loanId) internal view returns (RevenueNote) {
        return RevenueNote(hub.loan(loanId).note);
    }

    function _creditLine(uint256 loanId) internal view returns (CreditLine) {
        return CreditLine(hub.loan(loanId).creditLine);
    }

    function _auction(uint256 loanId) internal view returns (MockAuction) {
        return MockAuction(hub.loan(loanId).auction);
    }

    /// @dev Ends the loan's auction and settles it. A graduated auction raises `raised` USDC with
    /// the whole note supply sold to `lender` (so the repayment cap stays at `CAP_USDC`); a failed
    /// one sells nothing.
    function _settle(uint256 loanId, uint256 raised, bool graduated) internal {
        _prepareSettle(loanId, raised, graduated).settleAuction();
    }

    /// @dev Everything `_settle` does short of calling `settleAuction` on the returned credit line.
    function _prepareSettle(uint256 loanId, uint256 raised, bool graduated) internal returns (CreditLine) {
        MockAuction auction = _auction(loanId);
        if (graduated) {
            usdc.mint(address(auction), raised);
            auction.recordSale(lender, NOTE_SUPPLY);
        }
        auction.setGraduated(graduated);
        vm.roll(auction.endBlock());
        return _creditLine(loanId);
    }

    /// @dev Opens the default term sheet and settles its auction as graduated with `raised` USDC.
    function _openActive(uint256 raised) internal returns (uint256 loanId) {
        loanId = _open();
        _settle(loanId, raised, true);
    }

    function _draw(uint256 loanId, uint256 amount) internal {
        address creditLine = address(_creditLine(loanId));
        vm.prank(cardOwner);
        card.drawCredit(creditLine, amount);
    }

    /// @dev Sends `amount` USDC to the loan's escrow and has a keeper harvest it into the note.
    function _repay(uint256 loanId, uint256 amount) internal {
        RevenueEscrow escrow = _fundEscrow(loanId, amount);
        vm.prank(keeper);
        escrow.harvest(0);
    }

    /// @dev Sends `amount` USDC to the loan's escrow, ready for a harvest.
    function _fundEscrow(uint256 loanId, uint256 amount) internal returns (RevenueEscrow escrow) {
        escrow = _escrow(loanId);
        usdc.mint(address(escrow), amount);
    }

    /// @dev Moves time just past the loan's default eligibility.
    function _warpPastGrace(uint256 loanId) internal {
        vm.warp(uint256(_escrow(loanId).lastRevenueAt()) + GRACE_PERIOD + 1);
    }

    // ---------------------------------------------------------------------------------------
    // assertions
    // ---------------------------------------------------------------------------------------

    function _assertStatus(uint256 loanId, IAdvance.LoanStatus expected) internal view {
        assertEq(uint8(hub.loan(loanId).status), uint8(expected), "loan status");
    }

    /// @dev The calls, delegatecalls and contract creations `from` made directly, in order, from a
    /// state-diff recording. The recorder attributes a delegatecall to the outer caller rather than
    /// to `from`, so delegatecalls are matched by call depth instead: one frame below the first
    /// call into `from`. Creations and calls are matched by accessor. Selectors are zero for
    /// creations.
    function _accessesFrom(Vm.AccountAccess[] memory accesses, address from)
        internal
        pure
        returns (VmSafe.AccountAccessKind[] memory kinds, address[] memory targets, bytes4[] memory selectors)
    {
        uint64 innerDepth;
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].account == from && accesses[i].kind == VmSafe.AccountAccessKind.Call) {
                innerDepth = accesses[i].depth + 1;
                break;
            }
        }
        kinds = new VmSafe.AccountAccessKind[](accesses.length);
        targets = new address[](accesses.length);
        selectors = new bytes4[](accesses.length);
        uint256 count;
        for (uint256 i; i < accesses.length; ++i) {
            Vm.AccountAccess memory access = accesses[i];
            bool matches = (access.kind == VmSafe.AccountAccessKind.Call && access.accessor == from)
                || (access.kind == VmSafe.AccountAccessKind.Create && access.accessor == from)
                || (access.kind == VmSafe.AccountAccessKind.DelegateCall && access.depth == innerDepth);
            if (!matches) continue;
            kinds[count] = access.kind;
            targets[count] = access.account;
            if (access.kind != VmSafe.AccountAccessKind.Create && access.data.length >= 4) {
                selectors[count] = bytes4(access.data);
            }
            count++;
        }
        assembly ("memory-safe") {
            mstore(kinds, count)
            mstore(targets, count)
            mstore(selectors, count)
        }
    }

    /// @dev Only the plain calls from `_accessesFrom`, in order.
    function _callsFrom(Vm.AccountAccess[] memory accesses, address from)
        internal
        pure
        returns (address[] memory targets, bytes4[] memory selectors)
    {
        (VmSafe.AccountAccessKind[] memory kinds, address[] memory allTargets, bytes4[] memory allSelectors) =
            _accessesFrom(accesses, from);
        targets = new address[](kinds.length);
        selectors = new bytes4[](kinds.length);
        uint256 count;
        for (uint256 i; i < kinds.length; ++i) {
            if (kinds[i] != VmSafe.AccountAccessKind.Call) continue;
            targets[count] = allTargets[i];
            selectors[count] = allSelectors[i];
            count++;
        }
        assembly ("memory-safe") {
            mstore(targets, count)
            mstore(selectors, count)
        }
    }

    /// @dev The EIP-712 struct hash the hub keys loans by.
    function _hash(TermSheet memory ts) internal pure returns (bytes32) {
        return TermSheetLib.structHash(ts);
    }
}
