// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AdvanceHub} from "../../src/AdvanceHub.sol";
import {AgentCard} from "../../src/AgentCard.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {EscrowDeployer} from "../../src/deployers/EscrowDeployer.sol";
import {LoanDeployer} from "../../src/deployers/LoanDeployer.sol";
import {IAdvance} from "../../src/interfaces/IAdvance.sol";
import {ICCA} from "../../src/interfaces/ICCA.sol";
import {IDopplerFeesManager, PoolKey} from "../../src/interfaces/IDopplerFeesManager.sol";
import {IIdentityRegistry, IReputationRegistry} from "../../src/interfaces/IERC8004.sol";
import {TermSheet, TermSheetLib} from "../../src/lib/TermSheetLib.sol";
import {V4PoolKey, V4Swapper} from "../utils/V4Swapper.sol";

/// @notice Permit2's AllowanceTransfer approval, which the CCA pulls bids through.
interface IPermit2 {
    /// @notice Lets `spender` pull up to `amount` of `token` from the caller until `expiration`.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice CCA reads Advance itself never makes, used by these tests to check the auction's own
/// view of a settlement against the credit line's.
interface ICCAView {
    /// @notice The auction's current clearing price, Q96 currency-wei per token-wei.
    function clearingPrice() external view returns (uint256);
    /// @notice Currency raised at the clearing price so far.
    function currencyRaised() external view returns (uint256);
    /// @notice Tokens cleared to bidders so far.
    function totalCleared() external view returns (uint256);
    /// @notice Tokens not yet cleared to any bidder.
    function remainingSupply() external view returns (uint256);
}

/// @notice Shared fixture for the Advance fork suites: an AdvanceHub wired to the live Base
/// USDC, WETH, Uniswap CCA factory, SwapRouter02, Chainlink ETH/USD and sequencer feeds and
/// ERC-8004 registries, lending against a real Doppler fee stream (the Ratspeak/WETH pool, whose
/// creator's 95% beneficiary share is moved onto the loan's escrow exactly as an agent would).
/// Fees are real: `_buyWeth` pushes volume through the pool's Uniswap v4 hook and the fees
/// manager releases the escrow's share of what that volume accrued.
/// @dev Runs under the `fork` profile, which pins Base mainnet at block 51403692. `setUp` skips
/// the whole suite when the test did not land on Base (chain id 8453), so a plain `forge test`
/// never reaches the network.
abstract contract ForkBase is Test {
    // -------------------------------------------------------------------------------------
    // live Base addresses
    // -------------------------------------------------------------------------------------

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    address internal constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant ETH_USD_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant SEQUENCER_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    /// @notice Doppler fees manager Bankr launches (and the Ratspeak pool's v4 hook).
    address internal constant FEES_MANAGER = 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544;
    /// @notice The Ratspeak/WETH Doppler pool the loans are underwritten against.
    bytes32 internal constant POOL_ID = 0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6;
    /// @notice The Ratspeak token: the pool's non-WETH leg, forwarded to the treasury on harvest.
    address internal constant AGENT_TOKEN = 0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3;
    /// @notice The pool creator, holder of the 95% creator beneficiary share and, in these tests,
    /// the agent treasury that borrows against it.
    address internal constant POOL_CREATOR = 0x96C33027948124a63E885fc34C29692d5A898765;
    /// @notice The creator's beneficiary share; the remaining 5% is the protocol's and never moves.
    uint256 internal constant CREATOR_SHARES = 0.95e18;

    /// @notice The block the `fork` profile pins.
    uint256 internal constant FORK_BLOCK = 51403692;
    /// @notice Base's block time, used to keep `block.timestamp` honest across `vm.roll`.
    uint256 internal constant BLOCK_TIME = 2;

    // -------------------------------------------------------------------------------------
    // loan terms
    // -------------------------------------------------------------------------------------

    uint256 internal constant UNDERWRITER_KEY = 0xA11CE;
    /// @notice Note supply: 5e18 note-wei, a $5 repayment cap.
    uint256 internal constant NOTE_SUPPLY = 5e18;
    /// @notice The repayment cap `NOTE_SUPPLY` implies, in USDC-wei.
    uint256 internal constant CAP_USDC = 5e6;
    uint16 internal constant FLOOR_CENTS = 80;
    uint128 internal constant MIN_PRINCIPAL = 2e6;
    /// @notice 250 blocks (~8 minutes on Base) and a divisor of 1e7, as the CCA schedule requires.
    uint64 internal constant AUCTION_BLOCKS = 250;
    uint128 internal constant DRAW_LIMIT = 1e6;
    /// @notice Compressed from the mainnet day so a fork test can cross a period boundary without
    /// outrunning the ETH/USD feed's `maxStaleness`.
    uint64 internal constant DRAW_PERIOD = 600;
    /// @notice Likewise compressed; long enough that an ordinary harvest cadence never trips it.
    uint64 internal constant GRACE_PERIOD = 1800;
    bytes32 internal constant MEMO_HASH = keccak256("advance/fork/evidence-bundle");

    /// @notice One hour, comfortably above the ETH/USD feed's 20-minute heartbeat on Base.
    uint64 internal constant MAX_STALENESS = 3600;
    uint16 internal constant SLIPPAGE_BPS = 100;
    /// @notice $1 of fee-derived repayment before the escrow's default timer moves.
    uint256 internal constant MIN_ACTIVITY_USDC = 1e6;

    uint256 internal constant PER_CALL_CAP = 100_000;
    uint64 internal constant MAX_AUTH_WINDOW = 300;

    /// @notice CCA tick: $0.01 per note as a Q96 price in USDC-wei per note-wei.
    uint256 internal constant TICK_Q96 = uint256(1e4 << 96) / 1e18;
    /// @notice The auction floor, $0.80 per note.
    uint256 internal constant FLOOR_Q96 = TICK_Q96 * FLOOR_CENTS;

    // -------------------------------------------------------------------------------------
    // fixture
    // -------------------------------------------------------------------------------------

    AdvanceHub internal hub;
    AgentCard internal card;
    EscrowDeployer internal escrowDeployer;
    LoanDeployer internal loanDeployer;
    V4Swapper internal swapper;

    address internal underwriter;
    address internal hubOwner = makeAddr("hubOwner");
    /// @notice The agent's own EOA: owns the ERC-8004 agent id and the card's signing key. Never
    /// the hub, so the hub's feedback is not self-feedback.
    address internal agentOwner = makeAddr("agentOwner");
    address internal payee = makeAddr("payee");
    address internal keeper = makeAddr("keeper");
    address internal trader = makeAddr("trader");
    address internal bidderA = makeAddr("bidderA");
    address internal bidderB = makeAddr("bidderB");

    /// @notice The agent id registered on the live ERC-8004 identity registry in `setUp`.
    uint256 internal agentId;
    /// @notice The pool's Uniswap v4 key, read from the live fees manager.
    V4PoolKey internal poolKey;
    /// @notice Whether the pool's WETH leg is `currency0` (it is, for this pool).
    bool internal wethIsCurrency0;

    function setUp() public virtual {
        // The `fork` profile forks Base at a pinned block (see foundry.toml). A plain `forge test`
        // never forks, so skip rather than act on an unforked chain id.
        if (block.chainid != 8453) {
            vm.skip(true);
            return;
        }

        assertEq(vm.getBlockNumber(), FORK_BLOCK, "the fork profile pins Base at the fixture block");
        assertEq(_shares(POOL_CREATOR), CREATOR_SHARES, "the pool creator still holds its 95% share");

        underwriter = vm.addr(UNDERWRITER_KEY);
        // Well-known keys have picked up EIP-7702 delegations on Base; strip any code so these
        // addresses behave as plain EOAs, and fund everything that sends a transaction.
        address[6] memory eoas = [underwriter, agentOwner, keeper, trader, bidderA, bidderB];
        for (uint256 i; i < eoas.length; ++i) {
            vm.etch(eoas[i], "");
            vm.deal(eoas[i], 100 ether);
        }
        vm.etch(POOL_CREATOR, "");
        vm.deal(POOL_CREATOR, 100 ether);

        escrowDeployer = new EscrowDeployer();
        loanDeployer = new LoanDeployer();
        hub = new AdvanceHub(_hubConfig(), underwriter, hubOwner, escrowDeployer, loanDeployer);

        address[] memory payees = new address[](1);
        payees[0] = payee;
        card = new AgentCard(agentOwner, address(hub), USDC, PER_CALL_CAP, MAX_AUTH_WINDOW, payees);

        vm.prank(agentOwner);
        agentId = IIdentityRegistry(IDENTITY_REGISTRY).register();

        swapper = new V4Swapper();
        PoolKey memory key = IDopplerFeesManager(FEES_MANAGER).getPoolKey(POOL_ID);
        poolKey = V4PoolKey({
            currency0: key.currency0,
            currency1: key.currency1,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: key.hooks
        });
        wethIsCurrency0 = key.currency0 == WETH;

        vm.startPrank(trader);
        IERC20(WETH).approve(address(swapper), type(uint256).max);
        IERC20(AGENT_TOKEN).approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function _hubConfig() internal pure returns (AdvanceHub.Config memory) {
        return AdvanceHub.Config({
            usdc: USDC,
            weth: WETH,
            ccaFactory: CCA_FACTORY,
            router: SWAP_ROUTER,
            ethUsdFeed: ETH_USD_FEED,
            sequencerFeed: SEQUENCER_FEED,
            reputationRegistry: REPUTATION_REGISTRY,
            maxStaleness: MAX_STALENESS,
            slippageBps: SLIPPAGE_BPS,
            minActivityUsdc: MIN_ACTIVITY_USDC
        });
    }

    // -------------------------------------------------------------------------------------
    // term sheets
    // -------------------------------------------------------------------------------------

    /// @dev The fixture term sheet: $5 of notes against the live pool's fee stream, floored at
    /// $0.80, graduating at $2.00, drawable $1.00 per ten minutes.
    function _termSheet() internal view returns (TermSheet memory) {
        return TermSheet({
            agentTreasury: POOL_CREATOR,
            agentCard: address(card),
            agentId: agentId,
            feesManager: FEES_MANAGER,
            poolId: POOL_ID,
            expectedShares: CREATOR_SHARES,
            noteSupply: NOTE_SUPPLY,
            floorCents: FLOOR_CENTS,
            minPrincipal: MIN_PRINCIPAL,
            auctionBlocks: AUCTION_BLOCKS,
            drawLimit: DRAW_LIMIT,
            drawPeriod: DRAW_PERIOD,
            gracePeriod: GRACE_PERIOD,
            deadline: uint64(vm.getBlockTimestamp() + 1 days),
            nonce: 1,
            memoHash: MEMO_HASH
        });
    }

    function _sign(TermSheet memory ts) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(UNDERWRITER_KEY, hub.termSheetDigest(ts));
        return abi.encodePacked(r, s, v);
    }

    // -------------------------------------------------------------------------------------
    // lifecycle helpers
    // -------------------------------------------------------------------------------------

    /// @dev The agent treasury moves its live Doppler creator share onto the term sheet's
    /// predicted escrow, which is what makes the loan bankable in the first place.
    function _onboard(TermSheet memory ts) internal returns (address escrow) {
        escrow = hub.predictEscrow(ts);
        vm.prank(POOL_CREATOR);
        IDopplerFeesManager(FEES_MANAGER).updateBeneficiary(POOL_ID, escrow);
    }

    /// @dev Onboards and opens the loan from the agent treasury, returning the gas `openLoan` used.
    function _open(TermSheet memory ts) internal returns (uint256 loanId, uint256 gasUsed) {
        _onboard(ts);
        bytes memory signature = _sign(ts);
        vm.prank(POOL_CREATOR);
        uint256 before = gasleft();
        loanId = hub.openLoan(ts, signature);
        gasUsed = before - gasleft();
    }

    /// @dev Commits `amount` USDC-wei at a maximum price of `cents` per note, funding the bidder
    /// and routing the approval through Permit2 the way the CCA pulls a bid's funds.
    function _bid(address bidder, address auction, uint16 cents, uint128 amount) internal returns (uint256 bidId) {
        deal(USDC, bidder, IERC20(USDC).balanceOf(bidder) + amount);
        vm.startPrank(bidder);
        IERC20(USDC).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(USDC, auction, amount, uint48(vm.getBlockTimestamp() + 1 days));
        bidId = ICCA(auction).submitBid(TICK_Q96 * cents, amount, bidder, FLOOR_Q96, "");
        vm.stopPrank();
    }

    /// @dev Advances to `blockNumber`, keeping `block.timestamp` on Base's two-second cadence so
    /// the Chainlink staleness checks see a plausible timeline.
    function _rollTo(uint256 blockNumber) internal {
        uint256 current = vm.getBlockNumber();
        if (blockNumber <= current) return;
        vm.warp(vm.getBlockTimestamp() + (blockNumber - current) * BLOCK_TIME);
        vm.roll(blockNumber);
    }

    /// @dev Runs the auction out, checkpoints it, and settles it from a keeper.
    function _endAuctionAndSettle(uint256 loanId) internal returns (uint256 gasUsed) {
        ICCA auction = ICCA(hub.loan(loanId).auction);
        _rollTo(auction.endBlock());
        auction.checkpoint();

        CreditLine creditLine = _creditLine(loanId);
        vm.prank(keeper);
        uint256 before = gasleft();
        creditLine.settleAuction();
        gasUsed = before - gasleft();
    }

    /// @dev Buys the agent token with `wethIn` WETH through the pool's real v4 hook, which is what
    /// accrues the LP fees the fees manager later releases to the escrow.
    function _buyWeth(uint256 wethIn) internal {
        deal(WETH, trader, IERC20(WETH).balanceOf(trader) + wethIn);
        vm.prank(trader);
        swapper.swapExactIn(poolKey, wethIsCurrency0, wethIn);
    }

    /// @dev Sells `tokenIn` of the agent token back through the pool, accruing fees on the token leg.
    function _sellAgentToken(uint256 tokenIn) internal {
        vm.prank(trader);
        swapper.swapExactIn(poolKey, !wethIsCurrency0, tokenIn);
    }

    /// @dev A keeper harvest, returning the USDC distributed to the note and the gas it cost.
    function _harvest(uint256 loanId) internal returns (uint256 repaid, uint256 gasUsed) {
        RevenueEscrow escrow = _escrow(loanId);
        vm.prank(keeper);
        uint256 before = gasleft();
        repaid = escrow.harvest(0);
        gasUsed = before - gasleft();
    }

    // -------------------------------------------------------------------------------------
    // views
    // -------------------------------------------------------------------------------------

    function _escrow(uint256 loanId) internal view returns (RevenueEscrow) {
        return RevenueEscrow(payable(hub.loan(loanId).escrow));
    }

    function _note(uint256 loanId) internal view returns (RevenueNote) {
        return RevenueNote(hub.loan(loanId).note);
    }

    function _creditLine(uint256 loanId) internal view returns (CreditLine) {
        return CreditLine(hub.loan(loanId).creditLine);
    }

    function _auction(uint256 loanId) internal view returns (ICCA) {
        return ICCA(hub.loan(loanId).auction);
    }

    function _shares(address holder) internal view returns (uint256) {
        return IDopplerFeesManager(FEES_MANAGER).getShares(POOL_ID, holder);
    }

    function _assertStatus(uint256 loanId, IAdvance.LoanStatus expected) internal view {
        assertEq(uint8(hub.loan(loanId).status), uint8(expected), "loan status");
    }

    /// @dev The hub's last feedback entry about the agent, read back from the live registry.
    function _readHubFeedback(uint64 index)
        internal
        view
        returns (int128 value, string memory tag1, string memory tag2)
    {
        (value,, tag1, tag2,) = IReputationRegistry(REPUTATION_REGISTRY).readFeedback(agentId, address(hub), index);
    }

    /// @dev The EIP-712 struct hash the hub keys term sheets by.
    function _hash(TermSheet memory ts) internal pure returns (bytes32) {
        return TermSheetLib.structHash(ts);
    }

    /// @dev Prints a USDC amount, in USDC-wei (six decimals).
    function _logUsdc(string memory label, uint256 amount) internal pure {
        console2.log(label, amount, "USDC-wei");
    }

    /// @dev Prints every plain call a recorded transaction made, in order, as `target selector`,
    /// which is the shape a block explorer shows for the same transaction.
    function _logCalls(string memory label, VmSafe.AccountAccess[] memory accesses) internal pure {
        console2.log(label);
        for (uint256 i; i < accesses.length; ++i) {
            VmSafe.AccountAccess memory access = accesses[i];
            if (access.kind != VmSafe.AccountAccessKind.Call || access.data.length < 4) continue;
            console2.log(
                string.concat(
                    "  ",
                    vm.toString(access.account),
                    " ",
                    vm.toString(abi.encodePacked(bytes4(access.data))),
                    access.reverted ? " reverted" : ""
                )
            );
        }
    }
}
