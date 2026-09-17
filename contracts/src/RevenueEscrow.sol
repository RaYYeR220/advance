// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAdvanceHub} from "./interfaces/IAdvanceHub.sol";
import {IDopplerFeesManager, PoolKey} from "./interfaces/IDopplerFeesManager.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {OracleLib} from "./lib/OracleLib.sol";
import {CreditLine} from "./CreditLine.sol";
import {RevenueNote} from "./RevenueNote.sol";

/// @title RevenueEscrow
/// @notice Holds an agent token's Doppler fee-beneficiary shares for the life of one loan.
/// Anyone can `harvest`: the escrow collects its own share of the pool's fees (the fees manager
/// only ever pays the caller), forwards the agent-token leg to the agent treasury, and, while
/// the loan is Active, swaps the WETH leg to USDC under a Chainlink-derived minimum and
/// distributes it to the loan's revenue note up to the note's cap. Once the cap is reached it
/// hands the beneficiary shares back to the treasury and tells the hub. Before activation, and
/// after closing, everything it receives is forwarded raw to the treasury.
contract RevenueEscrow is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Lifecycle of the escrow.
    /// @dev `Pending` until the hub activates a graduated loan (fees go raw to the treasury);
    /// `Active` while fees repay the note; `Closed` (terminal) once repaid or released.
    enum Phase {
        Pending,
        Active,
        Closed
    }

    /// @notice Deployment configuration.
    /// @param hub AdvanceHub; the only caller allowed to `bind`, `activate` and `release`.
    /// @param feesManager Doppler fees manager holding the pool's beneficiary shares.
    /// @param poolId Uniswap v4 pool id of the agent token's pool.
    /// @param treasury Agent treasury; receives forwarded fees, overflow and the returned shares.
    /// @param usdc USDC token repayments are paid in.
    /// @param weth WETH token; the pool's ETH leg, swapped to USDC while Active.
    /// @param router Uniswap SwapRouter02 used for the WETH->USDC swap.
    /// @param ethUsdFeed Chainlink ETH/USD feed bounding the swap's minimum output.
    /// @param sequencerFeed Chainlink L2 sequencer uptime feed; `address(0)` skips the check.
    /// @param maxStaleness Maximum age, in seconds, of the ETH/USD price.
    /// @param slippageBps Allowed swap slippage below the oracle price, in basis points.
    struct Config {
        address hub;
        address feesManager;
        bytes32 poolId;
        address treasury;
        address usdc;
        address weth;
        address router;
        address ethUsdFeed;
        address sequencerFeed;
        uint64 maxStaleness;
        uint16 slippageBps;
    }

    /// @notice Smallest WETH balance worth swapping; below it the WETH is kept for a later harvest.
    uint256 public constant MIN_SWAP_WETH = 1e12;

    /// @dev Uniswap v3 WETH/USDC pool fee tier used for the swap (0.05%).
    uint24 internal constant SWAP_POOL_FEE = 500;

    /// @notice AdvanceHub; the only caller allowed to `bind`, `activate` and `release`.
    address public immutable hub;
    /// @notice Doppler fees manager holding the pool's beneficiary shares.
    IDopplerFeesManager public immutable feesManager;
    /// @notice Uniswap v4 pool id of the agent token's pool.
    bytes32 public immutable poolId;
    /// @notice Agent treasury; receives forwarded fees, overflow and the returned shares.
    address public immutable treasury;
    /// @notice USDC token repayments are paid in.
    IERC20 public immutable usdc;
    /// @notice WETH token; the pool's ETH leg.
    IERC20 public immutable weth;
    /// @notice Uniswap SwapRouter02 used for the WETH->USDC swap.
    ISwapRouter02 public immutable router;
    /// @notice Chainlink ETH/USD feed bounding the swap's minimum output.
    address public immutable ethUsdFeed;
    /// @notice Chainlink L2 sequencer uptime feed; `address(0)` skips the sequencer check.
    address public immutable sequencerFeed;
    /// @notice Maximum age, in seconds, of the ETH/USD price.
    uint64 public immutable maxStaleness;
    /// @notice Allowed swap slippage below the oracle price, in basis points.
    uint16 public immutable slippageBps;

    /// @notice Current lifecycle phase.
    Phase public phase;
    /// @notice Timestamp of activation or of the last harvest that paid USDC into the note.
    uint64 public lastRevenueAt;
    /// @notice The loan's revenue note (unset until `bind`).
    RevenueNote public note;
    /// @notice The loan's credit line (unset until `bind`).
    address public creditLine;
    /// @notice The loan id this escrow is bound to (0 until `bind`).
    uint256 public loanId;

    /// @notice Emitted by every harvest while Active.
    /// @param wethIn WETH swapped (0 if the balance was below `MIN_SWAP_WETH`).
    /// @param usdcOut USDC received from the swap.
    /// @param toNotes USDC distributed to the note.
    /// @param toTreasury USDC above the note's cap, sent to the treasury.
    event Harvested(uint256 wethIn, uint256 usdcOut, uint256 toNotes, uint256 toTreasury);
    /// @notice Emitted when a token balance is sent to the treasury.
    /// @param token The token forwarded.
    /// @param amount The amount forwarded.
    event Forwarded(address indexed token, uint256 amount);
    /// @notice Emitted when sending a token balance to the treasury failed; the balance stays in
    /// the escrow and is retried by the next harvest.
    /// @param token The token that could not be forwarded.
    /// @param amount The amount that could not be forwarded (0 if its balance was unreadable).
    event ForwardFailed(address indexed token, uint256 amount);
    /// @notice Emitted when the escrow moves all of its beneficiary shares to the treasury.
    /// @param treasury The treasury that now holds the shares.
    event BeneficiaryReturned(address indexed treasury);
    /// @notice Emitted when `release` could not collect fees first; the hand-back still releases
    /// already-cumulated fees, and uncollected ones accrue to the treasury's shares.
    event CollectFailed();

    /// @notice Thrown when a caller other than `hub` calls a hub-only function.
    error NotHub();
    /// @notice Thrown when `bind` is called a second time.
    error AlreadyBound();
    /// @notice Thrown when a function is called from a phase it does not allow.
    error WrongPhase();
    /// @notice Thrown when a required address argument is zero.
    error ZeroAddress();
    /// @notice Thrown when `activate` is called before `bind`.
    error NotBound();
    /// @notice Thrown when `closeIfRepaid` is called while the note still has cap remaining.
    /// @param remaining The note's remaining USDC cap.
    error NotRepaid(uint256 remaining);
    /// @notice Thrown by `bind` when the pool does not pair exactly one ETH leg (WETH or native)
    /// with an agent token that is neither ETH nor USDC.
    error UnsupportedPool();
    /// @notice Thrown by `bind` when the note is not denominated in this escrow's USDC.
    error InvalidNote();
    /// @notice Thrown when the credit line's state does not allow the call (`activate` needs
    /// Active, `release` of a bound loan needs Failed).
    /// @param current The credit line's actual state.
    error WrongCreditLineState(CreditLine.State current);
    /// @notice Thrown when the swap delivered less USDC than the enforced minimum.
    /// @param received USDC actually received.
    /// @param minimum The minimum that was required.
    error InsufficientOutput(uint256 received, uint256 minimum);

    /// @param cfg Deployment configuration; every address except `sequencerFeed` must be nonzero.
    constructor(Config memory cfg) {
        if (
            cfg.hub == address(0) || cfg.feesManager == address(0) || cfg.treasury == address(0)
                || cfg.usdc == address(0) || cfg.weth == address(0) || cfg.router == address(0)
                || cfg.ethUsdFeed == address(0)
        ) revert ZeroAddress();

        hub = cfg.hub;
        feesManager = IDopplerFeesManager(cfg.feesManager);
        poolId = cfg.poolId;
        treasury = cfg.treasury;
        usdc = IERC20(cfg.usdc);
        weth = IERC20(cfg.weth);
        router = ISwapRouter02(cfg.router);
        ethUsdFeed = cfg.ethUsdFeed;
        sequencerFeed = cfg.sequencerFeed;
        maxStaleness = cfg.maxStaleness;
        slippageBps = cfg.slippageBps;
    }

    /// @notice Wraps native ETH (e.g. fees from a native-ETH pool) into WETH so it is swapped or
    /// forwarded like the WETH leg. ETH sent by the WETH contract itself is left unwrapped.
    receive() external payable {
        if (msg.sender != address(weth)) IWETH(address(weth)).deposit{value: msg.value}();
    }

    /// @notice Binds this escrow to its loan. Callable once, by the hub. Rejects a note that is
    /// not paid in this escrow's USDC and a pool whose fees cannot be swapped into repayment.
    /// @param loanId_ The loan id.
    /// @param note_ The loan's revenue note.
    /// @param creditLine_ The loan's credit line.
    function bind(uint256 loanId_, address note_, address creditLine_) external {
        if (msg.sender != hub) revert NotHub();
        if (address(note) != address(0)) revert AlreadyBound();
        if (note_ == address(0) || creditLine_ == address(0)) revert ZeroAddress();
        if (address(RevenueNote(note_).usdc()) != address(usdc)) revert InvalidNote();

        PoolKey memory key = feesManager.getPoolKey(poolId);
        bool ethLeg0 = _isEthLeg(key.currency0);
        if (ethLeg0 == _isEthLeg(key.currency1)) revert UnsupportedPool();
        if ((ethLeg0 ? key.currency1 : key.currency0) == address(usdc)) revert UnsupportedPool();

        loanId = loanId_;
        note = RevenueNote(note_);
        creditLine = creditLine_;
    }

    /// @notice Starts routing fees into repayment. Callable once, by the hub, from Pending, after
    /// `bind`, and only once the credit line is Active: distributing while the credit line is
    /// still Pending could leave its settlement permanently reverting.
    function activate() external {
        if (msg.sender != hub) revert NotHub();
        if (address(note) == address(0)) revert NotBound();
        if (phase != Phase.Pending) revert WrongPhase();
        CreditLine.State state = CreditLine(creditLine).state();
        if (state != CreditLine.State.Active) revert WrongCreditLineState(state);

        phase = Phase.Active;
        lastRevenueAt = uint64(block.timestamp);
    }

    /// @notice Collects the escrow's fee share and routes it. Callable by anyone. The agent-token
    /// leg always goes to the treasury (a failed transfer never reverts the harvest). Unless
    /// Active, WETH and USDC go to the treasury too. While Active, WETH of at least
    /// `MIN_SWAP_WETH` is swapped to USDC with a minimum output of the larger of the oracle bound
    /// and `minUsdcOut`; USDC up to the note's remaining cap is distributed and the rest goes to
    /// the treasury; reaching the cap closes the escrow and returns the beneficiary shares.
    /// @param minUsdcOut Caller-supplied minimum swap output; only raises the oracle bound.
    /// @return repaid USDC distributed to the note by this call.
    function harvest(uint256 minUsdcOut) external nonReentrant returns (uint256 repaid) {
        feesManager.collectFees(poolId);

        PoolKey memory key = feesManager.getPoolKey(poolId);
        _forwardAgentLeg(key.currency0);
        _forwardAgentLeg(key.currency1);

        if (phase != Phase.Active) {
            _forward(address(weth));
            _forward(address(usdc));
            return 0;
        }

        uint256 wethIn = weth.balanceOf(address(this));
        uint256 usdcOut;
        if (wethIn >= MIN_SWAP_WETH) {
            usdcOut = _swapToUsdc(wethIn, minUsdcOut);
        } else {
            wethIn = 0;
        }

        RevenueNote note_ = note;
        uint256 usdcBalance = usdc.balanceOf(address(this));
        uint256 remainingCap = note_.remainingCap();
        repaid = usdcBalance < remainingCap ? usdcBalance : remainingCap;
        uint256 toTreasury = usdcBalance - repaid;

        if (repaid != 0) {
            lastRevenueAt = uint64(block.timestamp);
            usdc.forceApprove(address(note_), repaid);
            note_.distribute(repaid);
        }
        if (toTreasury != 0) _forward(address(usdc));

        emit Harvested(wethIn, usdcOut, repaid, toTreasury);

        if (note_.remainingCap() == 0) _close(key);
    }

    /// @notice Closes an Active escrow whose note is already repaid to its cap without
    /// harvesting (e.g. after the credit line filled the cap, or while the oracle is
    /// unavailable). Callable by anyone.
    function closeIfRepaid() external nonReentrant {
        if (phase != Phase.Active) revert WrongPhase();
        uint256 remaining = note.remainingCap();
        if (remaining != 0) revert NotRepaid(remaining);

        _close(feesManager.getPoolKey(poolId));
    }

    /// @notice Returns the beneficiary shares and every held balance to the treasury for a loan
    /// that failed its auction or was never opened. Callable once, by the hub, only from Pending,
    /// and, if the escrow is bound, only once the credit line is Failed. A failing fee collection
    /// does not block the hand-back.
    function release() external nonReentrant {
        if (msg.sender != hub) revert NotHub();
        if (phase != Phase.Pending) revert WrongPhase();
        if (creditLine != address(0)) {
            CreditLine.State state = CreditLine(creditLine).state();
            if (state != CreditLine.State.Failed) revert WrongCreditLineState(state);
        }

        phase = Phase.Closed;

        try feesManager.collectFees(poolId) {}
        catch {
            emit CollectFailed();
        }

        _returnBeneficiary();
        _sweep(feesManager.getPoolKey(poolId));
    }

    /// @dev Marks the escrow Closed, hands the shares back, forwards whatever the escrow still
    /// holds, and notifies the hub last.
    function _close(PoolKey memory key) internal {
        phase = Phase.Closed;
        _returnBeneficiary();
        _sweep(key);
        IAdvanceHub(hub).onRepaid(loanId);
    }

    /// @dev Moves all of the escrow's shares to the treasury. The fees manager first releases the
    /// escrow's already-cumulated fees to the escrow, which `_sweep` then forwards.
    function _returnBeneficiary() internal {
        feesManager.updateBeneficiary(poolId, treasury);
        emit BeneficiaryReturned(treasury);
    }

    /// @dev Forwards every balance the escrow can hold (agent leg, WETH, USDC) to the treasury.
    function _sweep(PoolKey memory key) internal {
        _forwardAgentLeg(key.currency0);
        _forwardAgentLeg(key.currency1);
        _forward(address(weth));
        _forward(address(usdc));
    }

    /// @dev Swaps `wethIn` WETH to USDC through the router, requiring at least the larger of the
    /// oracle bound and `keeperMin`, verified against the escrow's actual USDC balance change.
    function _swapToUsdc(uint256 wethIn, uint256 keeperMin) internal returns (uint256 usdcOut) {
        uint256 minOut = OracleLib.minUsdcOut(wethIn, ethUsdFeed, sequencerFeed, maxStaleness, slippageBps);
        if (keeperMin > minOut) minOut = keeperMin;

        uint256 usdcBefore = usdc.balanceOf(address(this));
        weth.forceApprove(address(router), wethIn);
        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(usdc),
                fee: SWAP_POOL_FEE,
                recipient: address(this),
                amountIn: wethIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 usdcAfter = usdc.balanceOf(address(this));

        usdcOut = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0;
        if (usdcOut < minOut) revert InsufficientOutput(usdcOut, minOut);
    }

    /// @dev Forwards a pool currency's balance unless it is the ETH leg (WETH, or native ETH,
    /// which `receive` has already wrapped).
    function _forwardAgentLeg(address currency) internal {
        if (!_isEthLeg(currency)) _forward(currency);
    }

    /// @dev Sends the escrow's whole `token` balance to the treasury without ever reverting: the
    /// balance read and the transfer are low-level calls that copy at most 32 bytes of return
    /// data, and any failure (revert, `false`, malformed or missing return data, no code) only
    /// emits `ForwardFailed`, leaving the balance for a later retry.
    function _forward(address token) internal {
        (bool readable, uint256 amount) = _tryBalanceOf(token);
        if (!readable) {
            emit ForwardFailed(token, 0);
            return;
        }
        if (amount == 0) return;

        if (IERC20(token).trySafeTransfer(treasury, amount)) {
            emit Forwarded(token, amount);
        } else {
            emit ForwardFailed(token, amount);
        }
    }

    /// @dev `token.balanceOf(this)` as a staticcall that never reverts and never copies more than
    /// one word of return data. `ok` is false if the call failed or returned less than one word.
    /// Calldata is built in the 0x00-0x23 scratch space only.
    function _tryBalanceOf(address token) internal view returns (bool ok, uint256 amount) {
        bytes4 selector = IERC20.balanceOf.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, address())
            ok := staticcall(gas(), token, 0x00, 0x24, 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            amount := mload(0x00)
        }
    }

    /// @dev Whether `currency` is the pool's ETH leg: WETH, or native ETH (`address(0)`).
    function _isEthLeg(address currency) internal view returns (bool) {
        return currency == address(weth) || currency == address(0);
    }
}
