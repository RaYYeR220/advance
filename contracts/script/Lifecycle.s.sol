// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AdvanceHub} from "../src/AdvanceHub.sol";
import {AgentCard} from "../src/AgentCard.sol";
import {CreditLine} from "../src/CreditLine.sol";
import {RevenueEscrow} from "../src/RevenueEscrow.sol";
import {RevenueNote} from "../src/RevenueNote.sol";
import {EscrowDeployer} from "../src/deployers/EscrowDeployer.sol";
import {LoanDeployer} from "../src/deployers/LoanDeployer.sol";
import {IAdvance} from "../src/interfaces/IAdvance.sol";
import {ICCA} from "../src/interfaces/ICCA.sol";
import {IDopplerFeesManager, PoolKey} from "../src/interfaces/IDopplerFeesManager.sol";
import {IIdentityRegistry, IReputationRegistry} from "../src/interfaces/IERC8004.sol";
import {TermSheet} from "../src/lib/TermSheetLib.sol";
import {V4PoolKey, V4Swapper} from "../test/utils/V4Swapper.sol";

/// @notice Permit2's AllowanceTransfer approval, which the CCA pulls bids through.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title Lifecycle
/// @notice Narrates one Advance loan end to end against a real Doppler fee stream, forked from
/// live Base mainnet: a fresh hub is deployed, the Ratspeak/WETH pool's creator share is pledged,
/// the note is sold through a real Uniswap CCA, the agent draws against the raised principal
/// (including one draw that is rejected for exceeding the period's limit), real swap volume pays
/// real LP fees into the escrow, and the note is repaid to its cap.
/// @dev Run against a running `anvil --fork-url https://mainnet.base.org --fork-block-number
/// 51403692` (see `script/lifecycle.sh`), which also supplies a `--private-key` (one of anvil's
/// public default dev keys) so forge skips wrapping the script in an on-chain proxy contract;
/// nothing is ever broadcast (no `--broadcast` flag), so that key only ever signs a local
/// simulation. Every protocol step is driven by `vm.prank` the same way the fork test suite drives
/// it, so the narrative is exact and needs no signing key for the live pool creator or the
/// auction's bidders.
contract Lifecycle is Script {
    // `Script` only pulls in `StdCheatsSafe`, which does not carry the ERC20 `deal` helper `Test`
    // gets from `StdCheats`; `_dealErc20` below reimplements it with the `stdstore` slot-search
    // `CommonBase` already gives every script, so USDC and WETH can still be dealt without a
    // broadcast or a real token source.
    using stdStorage for StdStorage;

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
    /// @notice The Ratspeak/WETH Doppler pool this demo underwrites against.
    bytes32 internal constant POOL_ID = 0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6;
    address internal constant AGENT_TOKEN = 0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3;
    /// @notice The pool creator, holder of the 95% creator beneficiary share and the agent
    /// treasury that borrows against it.
    address internal constant POOL_CREATOR = 0x96C33027948124a63E885fc34C29692d5A898765;
    uint256 internal constant CREATOR_SHARES = 0.95e18;

    uint256 internal constant FORK_BLOCK = 51403692;
    /// @notice Base's block time, used to keep `block.timestamp` honest across `vm.roll`.
    uint256 internal constant BLOCK_TIME = 2;

    uint256 internal constant UNDERWRITER_KEY = 0xA11CE;
    /// @notice Note supply: 5e18 note-wei, a $5 repayment cap.
    uint256 internal constant NOTE_SUPPLY = 5e18;
    uint16 internal constant FLOOR_CENTS = 80;
    uint128 internal constant MIN_PRINCIPAL = 2e6;
    /// @notice 250 blocks (~8 minutes on Base), a divisor of 1e7 as the CCA schedule requires.
    uint64 internal constant AUCTION_BLOCKS = 250;
    uint128 internal constant DRAW_LIMIT = 1e6;
    /// @notice Compressed so this demo does not need to wait a real day between draw periods.
    uint64 internal constant DRAW_PERIOD = 600;
    uint64 internal constant GRACE_PERIOD = 1800;
    bytes32 internal constant MEMO_HASH = keccak256("advance/lifecycle-demo/evidence-bundle");

    uint64 internal constant MAX_STALENESS = 3600;
    uint16 internal constant SLIPPAGE_BPS = 100;
    /// @notice Demo-scale activity threshold ($0.01) -- small enough that the first harvest after
    /// activation moves the escrow's default timer, unlike mainnet's $1 threshold.
    uint256 internal constant MIN_ACTIVITY_USDC = 10_000;

    uint256 internal constant PER_CALL_CAP = 100_000;
    uint64 internal constant MAX_AUTH_WINDOW = 300;

    uint256 internal constant TICK_Q96 = uint256(1e4 << 96) / 1e18;
    uint256 internal constant FLOOR_Q96 = TICK_Q96 * FLOOR_CENTS;

    uint128 internal constant BID_USDC = 2e6;
    /// @notice WETH pushed through the pool per keeper round; enough that a handful of harvests
    /// fill the $5 cap without an unbounded loop.
    uint256 internal constant SWAP_WETH = 0.2 ether;
    uint256 internal constant MAX_HARVESTS = 8;

    AdvanceHub internal hub;
    AgentCard internal card;
    V4Swapper internal swapper;

    address internal underwriter;
    address internal hubOwner = makeAddr("hubOwner");
    address internal agentOwner = makeAddr("agentOwner");
    address internal payee = makeAddr("payee");
    address internal keeper = makeAddr("keeper");
    address internal trader = makeAddr("trader");
    address internal bidderA = makeAddr("bidderA");
    address internal bidderB = makeAddr("bidderB");

    uint256 internal agentId;
    V4PoolKey internal poolKey;
    bool internal wethIsCurrency0;

    uint256 internal loanId;

    /// @notice Runs the whole narrated demo.
    function run() external {
        require(block.chainid == 8453, "Lifecycle demo expects a Base mainnet fork (chain id 8453)");
        require(vm.getBlockNumber() == FORK_BLOCK, "run against the pinned fork block (see script/lifecycle.sh)");

        _banner("ADVANCE -- one loan, start to finish, against a live Base fee stream");
        _setUp();
        _openLoan();
        _runAuction();
        _draws();
        _harvestUntilRepaid();
        _final();
    }

    // -----------------------------------------------------------------------------------------
    // setup
    // -----------------------------------------------------------------------------------------

    function _setUp() internal {
        _banner("1. setup");
        underwriter = vm.addr(UNDERWRITER_KEY);
        address[7] memory eoas = [underwriter, agentOwner, keeper, trader, bidderA, bidderB, hubOwner];
        for (uint256 i; i < eoas.length; ++i) {
            // Base mainnet accounts can carry EIP-7702 delegations; strip any code so these
            // addresses behave as plain EOAs.
            vm.etch(eoas[i], "");
            vm.deal(eoas[i], 100 ether);
        }
        vm.etch(POOL_CREATOR, "");
        vm.deal(POOL_CREATOR, 100 ether);

        EscrowDeployer escrowDeployer = new EscrowDeployer();
        LoanDeployer loanDeployer = new LoanDeployer();
        hub = new AdvanceHub(_hubConfig(), underwriter, hubOwner, escrowDeployer, loanDeployer);
        console2.log("AdvanceHub deployed at", address(hub));

        address[] memory payees = new address[](1);
        payees[0] = payee;
        card = new AgentCard(agentOwner, address(hub), USDC, PER_CALL_CAP, MAX_AUTH_WINDOW, payees);
        console2.log("AgentCard deployed at", address(card));

        vm.prank(agentOwner);
        agentId = IIdentityRegistry(IDENTITY_REGISTRY).register();
        console2.log("agent registered, ERC-8004 id", agentId);

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

    // -----------------------------------------------------------------------------------------
    // open
    // -----------------------------------------------------------------------------------------

    function _openLoan() internal {
        _banner("2. open -- the agent pledges its Doppler fee share and the underwriter signs");
        TermSheet memory ts = _termSheet();
        address predicted = hub.predictEscrow(ts);
        console2.log("predicted escrow", predicted);

        vm.prank(POOL_CREATOR);
        IDopplerFeesManager(FEES_MANAGER).updateBeneficiary(POOL_ID, predicted);
        console2.log("pool creator moved its 95% beneficiary share onto the predicted escrow");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(UNDERWRITER_KEY, hub.termSheetDigest(ts));
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(POOL_CREATOR);
        uint256 gasBefore = gasleft();
        loanId = hub.openLoan(ts, signature);
        uint256 gasUsed = gasBefore - gasleft();

        AdvanceHub.Loan memory loan_ = hub.loan(loanId);
        console2.log("loan opened, id", loanId);
        console2.log("  escrow    ", loan_.escrow);
        console2.log("  creditLine", loan_.creditLine);
        console2.log("  note      ", loan_.note);
        console2.log("  auction   ", loan_.auction);
        console2.log("  openLoan gas used", gasUsed);

        // The pool has been accruing real fees since long before this demo pledged its share; a
        // keeper harvest while still Pending forwards that backlog straight to the treasury (it
        // predates the loan, so it is not owed to noteholders) instead of letting it get folded
        // into the first post-activation harvest.
        vm.prank(keeper);
        uint256 backlogRepaid = RevenueEscrow(payable(loan_.escrow)).harvest(0);
        console2.log("keeper cleared the pre-existing fee backlog to the treasury before activation");
        console2.log("  repaid to noteholders by that clearing harvest (0 expected, still Pending)", backlogRepaid);
    }

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

    // -----------------------------------------------------------------------------------------
    // auction and settlement
    // -----------------------------------------------------------------------------------------

    function _runAuction() internal {
        _banner("3. auction -- two lenders bid above the floor, the auction graduates");
        ICCA auction = ICCA(hub.loan(loanId).auction);

        _rollTo(vm.getBlockNumber() + 1);
        uint256 bidA = _bid(bidderA, address(auction), 90, BID_USDC);
        uint256 bidB = _bid(bidderB, address(auction), 85, BID_USDC);
        console2.log("bidderA bid", BID_USDC, "USDC-wei at 90c, bid id", bidA);
        console2.log("bidderB bid", BID_USDC, "USDC-wei at 85c, bid id", bidB);

        _rollTo(auction.endBlock());
        auction.checkpoint();
        console2.log("auction graduated?", auction.isGraduated());

        _banner("4. settle -- anyone can settle once the auction ends");
        CreditLine creditLine = CreditLine(hub.loan(loanId).creditLine);
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        creditLine.settleAuction();
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("settleAuction gas used", gasUsed);
        console2.log("principal raised, USDC-wei", creditLine.principal());
        console2.log("loan status", uint8(hub.loan(loanId).status), "(2 = Active)");
        console2.log("escrow phase", uint8(RevenueEscrow(payable(hub.loan(loanId).escrow)).phase()), "(1 = Active)");
    }

    // -----------------------------------------------------------------------------------------
    // draws
    // -----------------------------------------------------------------------------------------

    function _draws() internal {
        _banner("5. draws -- the agent draws its period limit, then one draw is rejected");
        CreditLine creditLine = CreditLine(hub.loan(loanId).creditLine);

        vm.prank(agentOwner);
        card.drawCredit(address(creditLine), DRAW_LIMIT);
        console2.log(
            "drew the full period limit,", DRAW_LIMIT, "USDC-wei; card balance", IERC20(USDC).balanceOf(address(card))
        );

        uint256 overLimit = uint256(DRAW_LIMIT) + 1;
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(CreditLine.DrawLimitExceeded.selector, overLimit, 0));
        card.drawCredit(address(creditLine), overLimit);
        console2.log("draw of", overLimit, "USDC-wei reverted: DrawLimitExceeded(requested, available=0)");
    }

    // -----------------------------------------------------------------------------------------
    // harvests
    // -----------------------------------------------------------------------------------------

    function _harvestUntilRepaid() internal {
        _banner("6. harvests -- real swap volume pays real LP fees into the escrow");
        RevenueNote note = RevenueNote(hub.loan(loanId).note);
        RevenueEscrow escrow = RevenueEscrow(payable(hub.loan(loanId).escrow));

        uint256 rounds;
        while (hub.loan(loanId).status == IAdvance.LoanStatus.Active && rounds < MAX_HARVESTS) {
            _buyWeth(SWAP_WETH);
            // Round-trip so the pool also accrues fees on the agent-token leg, which the escrow
            // forwards to the treasury and never counts toward repayment.
            _sellAgentToken(IERC20(AGENT_TOKEN).balanceOf(trader) / 2);

            vm.prank(keeper);
            uint256 gasBefore = gasleft();
            uint256 repaid = escrow.harvest(0);
            uint256 gasUsed = gasBefore - gasleft();
            rounds++;

            console2.log("harvest", rounds, "gas used", gasUsed);
            console2.log("  distributed to noteholders", repaid, "USDC-wei");
        }

        console2.log("cap", note.capUsdc(), "USDC-wei");
        console2.log("total repaid", note.totalRepaid(), "USDC-wei");
    }

    function _buyWeth(uint256 wethIn) internal {
        _dealErc20(WETH, trader, IERC20(WETH).balanceOf(trader) + wethIn);
        vm.prank(trader);
        swapper.swapExactIn(poolKey, wethIsCurrency0, wethIn);
    }

    function _sellAgentToken(uint256 tokenIn) internal {
        vm.prank(trader);
        swapper.swapExactIn(poolKey, !wethIsCurrency0, tokenIn);
    }

    // -----------------------------------------------------------------------------------------
    // repaid
    // -----------------------------------------------------------------------------------------

    function _final() internal {
        _banner("7. repaid -- shares go home, the credit line closes, lenders claim");
        AdvanceHub.Loan memory loan_ = hub.loan(loanId);
        console2.log("final loan status", uint8(loan_.status), "(3 = Repaid)");
        console2.log("escrow phase", uint8(RevenueEscrow(payable(loan_.escrow)).phase()), "(2 = Closed)");
        console2.log("credit line state", uint8(CreditLine(loan_.creditLine).state()), "(3 = Closed)");
        console2.log("card frozen?", card.frozen());
        console2.log("card still bound to a live loan?", hub.liveLoanOf(address(card)) != 0);

        uint64 lastIndex = IReputationRegistry(REPUTATION_REGISTRY).getLastIndex(agentId, address(hub));
        (int128 value,, string memory tag1, string memory tag2,) =
            IReputationRegistry(REPUTATION_REGISTRY).readFeedback(agentId, address(hub), lastIndex);
        console2.log("ERC-8004 feedback posted:", tag1, tag2);
        console2.log("  value", value);

        ICCA auction = ICCA(loan_.auction);
        auction.exitBid(bidIdA);
        auction.exitBid(bidIdB);
        auction.claimTokens(bidIdA);
        auction.claimTokens(bidIdB);
        RevenueNote note = RevenueNote(loan_.note);
        uint256 claimedA = note.claimFor(bidderA);
        uint256 claimedB = note.claimFor(bidderB);
        console2.log("bidderA claimed", claimedA, "USDC-wei");
        console2.log("bidderB claimed", claimedB, "USDC-wei");

        _banner("done -- loan lifecycle reproduced end to end on a Base mainnet fork");
    }

    /// @dev The bid ids `_bid` assigned bidderA/bidderB, read back in `_final` to exit and claim.
    uint256 internal bidIdA;
    uint256 internal bidIdB;

    // -----------------------------------------------------------------------------------------
    // shared helpers
    // -----------------------------------------------------------------------------------------

    function _bid(address bidder, address auction, uint16 cents, uint128 amount) internal returns (uint256 bidId) {
        _dealErc20(USDC, bidder, IERC20(USDC).balanceOf(bidder) + amount);
        vm.startPrank(bidder);
        IERC20(USDC).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(USDC, auction, amount, uint48(vm.getBlockTimestamp() + 1 days));
        bidId = ICCA(auction).submitBid(TICK_Q96 * cents, amount, bidder, FLOOR_Q96, "");
        vm.stopPrank();
        if (bidder == bidderA) bidIdA = bidId;
        else bidIdB = bidId;
    }

    function _rollTo(uint256 blockNumber) internal {
        uint256 current = vm.getBlockNumber();
        if (blockNumber <= current) return;
        vm.warp(vm.getBlockTimestamp() + (blockNumber - current) * BLOCK_TIME);
        vm.roll(blockNumber);
    }

    function _banner(string memory label) internal pure {
        console2.log("");
        console2.log(string.concat("== ", label, " =="));
    }

    /// @dev Sets `to`'s balance of ERC20 `token` to `give` by locating and overwriting its balance
    /// storage slot, exactly as forge-std's `Test`-only `deal(token, to, give)` does.
    function _dealErc20(address token, address to, uint256 give) internal {
        stdstore.target(token).sig(IERC20.balanceOf.selector).with_key(to).checked_write(give);
    }
}
