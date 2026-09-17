// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IChainlink} from "../../src/interfaces/IChainlink.sol";
import {Checkpoint, ICCA} from "../../src/interfaces/ICCA.sol";
import {IAdvanceHub} from "../../src/interfaces/IAdvanceHub.sol";
import {IDopplerFeesManager, PoolKey} from "../../src/interfaces/IDopplerFeesManager.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {CreditLine} from "../../src/CreditLine.sol";

/// @notice Minimal Chainlink `AggregatorV3Interface` mock with settable answer/startedAt/updatedAt,
/// used for both the ETH/USD feed and the L2 sequencer uptime feed in OracleLib tests.
contract MockFeed is IChainlink {
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint8 public feedDecimals = 8;

    function setAnswer(int256 answer_) external {
        answer = answer_;
    }

    function setStartedAt(uint256 startedAt_) external {
        startedAt = startedAt_;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function setDecimals(uint8 decimals_) external {
        feedDecimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt_, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (0, answer, startedAt, updatedAt, 0);
    }
}

/// @notice Minimal stand-in for Base USDC's FiatTokenV2_2, implementing only what AgentCard's
/// x402 unit tests exercise: a real EIP-712 domain separator, the bytes-signature overload of
/// `transferWithAuthorization` (verified via OZ `SignatureChecker`, so a contract `from` is
/// routed through ERC-1271 `isValidSignature` exactly like the deployed token), and
/// `authorizationState` nonce tracking. `name_` is settable per instance so tests can exercise
/// both the mainnet ("USD Coin") and Sepolia ("USDC") domain names.
contract MockEIP3009USDC is ERC20 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 internal immutable _domainSeparator;

    /// @notice Whether `nonce` has already been used or canceled for `authorizer`.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();

    constructor(string memory name_) ERC20(name_, "USDC") {
        _domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name_)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice The EIP-712 domain separator this mock signs `transferWithAuthorization` against.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator;
    }

    /// @notice Bytes-signature overload of EIP-3009 `transferWithAuthorization`. Verifies `from`
    /// via `SignatureChecker` (ECDSA for an EOA, ERC-1271 `isValidSignature` for a contract),
    /// exactly like FiatTokenV2_2's real bytes overload.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        // forge-lint: disable-next-line(block-timestamp) mirrors FiatTokenV2_2's own validAfter check (strictly after)
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        // forge-lint: disable-next-line(block-timestamp) mirrors FiatTokenV2_2's own validBefore check
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidSignature();

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/// @notice Minimal mintable ERC20 with configurable decimals, standing in for USDC (6 decimals)
/// in RevenueNote tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal but faithful mock of a CCA v2.1.0 auction. Mirrors the real contract's
/// lazy-checkpoint semantics: `isGraduated()` reflects `pendingGraduated` (set via the test hook
/// `setGraduated`, standing in for bids that have landed) only once `checkpoint()` — or, per the
/// real contract's `ensureEndBlockIsCheckpointed` modifier, `sweepCurrency()`/`sweepUnsoldTokens()`/
/// `claimTokens()` — has actually run; before that it stays at whatever it last committed to
/// (0/false by default). `sweepCurrency` is `fundsRecipient`-only, callable once, only after
/// `endBlock`, and sweeps 0 (not a revert) when not graduated. Sold notes are NOT transferred out
/// at sale time (real CCA: filled bids sit in the auction until each bidder calls `claimTokens`,
/// which reverts before graduation) — tests record a sale via `recordSale`, which only does
/// bookkeeping. `sweepUnsoldTokens` is `tokensRecipient`-only, callable once, only after
/// `endBlock`, and moves `totalSold` less than this contract's whole note balance when graduated
/// (the real contract's `remainingSupply()`), or the whole balance when not (real `TOTAL_SUPPLY`,
/// since nothing can ever be claimed pre-graduation). `claimTokens(bidId)` pays out a recorded
/// sale's `owner` after `endBlock`, once graduated, once per bid. `checkpoint` and the unused
/// bid-lifecycle functions are no-ops; Advance's CreditLine never calls them.
contract MockAuction is ICCA {
    using SafeERC20 for IERC20;

    /// @dev A test-recorded filled bid: `amount` notes sold to `owner`, claimable via
    /// `claimTokens` once the auction has ended and graduated.
    struct SoldLot {
        address owner;
        uint256 amount;
        bool claimed;
    }

    IERC20 internal immutable _currency;
    IERC20 internal immutable _noteToken;
    address internal immutable _fundsRecipient;
    address internal immutable _tokensRecipient;
    uint64 internal immutable _endBlock;

    /// @dev What `isGraduated()` will report once a checkpoint runs; simulates bids that have
    /// landed but aren't yet reflected in on-chain graduation state.
    bool public pendingGraduated;
    /// @dev The checkpointed/committed graduation status; this is what `isGraduated()` returns.
    bool internal committedGraduated;

    bool public currencySwept;
    bool public unsoldSwept;

    /// @notice Cumulative notes recorded as sold/filled via `recordSale`, still physically held
    /// by this contract until claimed.
    uint256 public totalSold;
    mapping(uint256 bidId => SoldLot) internal _soldLots;
    uint256 internal _nextBidId;

    error NotFundsRecipient();
    error NotTokensRecipient();
    error AuctionNotOver();
    error AlreadySwept();
    error NotGraduated();
    error AlreadyClaimed();

    constructor(
        address currency_,
        address noteToken_,
        address fundsRecipient_,
        address tokensRecipient_,
        uint64 endBlockNumber_
    ) {
        _currency = IERC20(currency_);
        _noteToken = IERC20(noteToken_);
        _fundsRecipient = fundsRecipient_;
        _tokensRecipient = tokensRecipient_;
        _endBlock = endBlockNumber_;
    }

    /// @notice Test hook: sets what graduation will read as once checkpointed (simulates bids
    /// landing without yet running a checkpoint).
    function setGraduated(bool graduated_) external {
        pendingGraduated = graduated_;
    }

    /// @notice Test hook: records `amount` notes as sold/filled to `owner`, matching real CCA's
    /// bid-fill bookkeeping without modeling the full bid/exit lifecycle. The notes stay
    /// physically held by this contract (not transferred) until `claimTokens` is called with the
    /// returned `bidId`.
    /// @return bidId The id to claim this sale with.
    function recordSale(address owner, uint256 amount) external returns (uint256 bidId) {
        bidId = _nextBidId++;
        _soldLots[bidId] = SoldLot({owner: owner, amount: amount, claimed: false});
        totalSold += amount;
    }

    function onTokensReceived() external {}

    function submitBid(uint256, uint128, address, uint256, bytes calldata) external payable returns (uint256) {
        return 0;
    }

    function checkpoint() external returns (Checkpoint memory) {
        _checkpoint();
        return Checkpoint(0, 0, 0, 0, 0, 0);
    }

    function sweepCurrency() external {
        if (msg.sender != _fundsRecipient) revert NotFundsRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (currencySwept) revert AlreadySwept();
        currencySwept = true;
        _checkpoint();

        if (committedGraduated) {
            uint256 balance = _currency.balanceOf(address(this));
            if (balance != 0) _currency.safeTransfer(_fundsRecipient, balance);
        }
    }

    /// @notice Sweeps unsold notes: `balance - totalSold` when graduated (mirrors real CCA's
    /// `remainingSupply()`), or the whole balance when not (nothing is ever claimable
    /// pre-graduation, so `totalSold` never actually leaves in that case). Assumes, like real
    /// production usage, that this runs before any `claimTokens` call empties out sold notes —
    /// it is only ever called once, atomically, from `CreditLine.settleAuction`.
    function sweepUnsoldTokens() external {
        if (msg.sender != _tokensRecipient) revert NotTokensRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (unsoldSwept) revert AlreadySwept();
        unsoldSwept = true;
        _checkpoint();

        uint256 balance = _noteToken.balanceOf(address(this));
        uint256 unsold = committedGraduated ? balance - totalSold : balance;
        if (unsold != 0) _noteToken.safeTransfer(_tokensRecipient, unsold);
    }

    function endBlock() external view returns (uint64) {
        return _endBlock;
    }

    /// @notice Pays out a recorded sale's filled notes to its owner. Only after `endBlock`, only
    /// once graduated (checkpointing first, like the real contract), and only once per bid.
    function claimTokens(uint256 bidId) external {
        if (block.number < _endBlock) revert AuctionNotOver();
        _checkpoint();
        if (!committedGraduated) revert NotGraduated();

        SoldLot storage lot = _soldLots[bidId];
        if (lot.claimed) revert AlreadyClaimed();
        lot.claimed = true;

        if (lot.amount != 0) _noteToken.safeTransfer(lot.owner, lot.amount);
    }

    function exitBid(uint256) external {}

    function isGraduated() external view returns (bool) {
        return committedGraduated;
    }

    function currency() external view returns (address) {
        return address(_currency);
    }

    function token() external view returns (address) {
        return address(_noteToken);
    }

    function tokensRecipient() external view returns (address) {
        return _tokensRecipient;
    }

    function fundsRecipient() external view returns (address) {
        return _fundsRecipient;
    }

    /// @dev Commits `pendingGraduated` into the queryable `isGraduated()` value, mirroring the
    /// real contract's checkpoint-driven `$currencyRaisedQ96X7` update.
    function _checkpoint() internal {
        committedGraduated = pendingGraduated;
    }
}

/// @notice Minimal mock of AdvanceHub's CreditLine-facing callback, recording the last
/// `onAuctionSettled` call for assertions.
contract MockHub is IAdvanceHub {
    uint256 public callCount;
    uint256 public lastLoanId;
    bool public lastGraduated;

    /// @notice Number of `onRepaid` calls received.
    uint256 public repaidCallCount;
    /// @notice Loan id passed to the last `onRepaid` call.
    uint256 public lastRepaidLoanId;

    function onAuctionSettled(uint256 loanId_, bool graduated_) external {
        callCount++;
        lastLoanId = loanId_;
        lastGraduated = graduated_;
    }

    function onRepaid(uint256 loanId_) external {
        repaidCallCount++;
        lastRepaidLoanId = loanId_;
    }
}

/// @notice WETH9-style wrapper: `deposit` mints 1:1 against attached ETH, `withdraw` burns and
/// sends ETH back to the caller.
contract MockWETH is ERC20 {
    error EthTransferFailed();

    constructor() ERC20("Wrapped Ether", "WETH") {}

    receive() external payable {
        _mint(msg.sender, msg.value);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}

/// @notice Stand-in for a CreditLine that only exposes a settable `state()`, for contracts that
/// gate on the credit line's lifecycle without exercising the rest of it.
contract MockCreditLine {
    CreditLine.State public state;

    function setState(CreditLine.State state_) external {
        state = state_;
    }
}

/// @notice Minimal `draw(uint256)`-only credit line stand-in that transfers a settable, fixed
/// amount regardless of what was requested -- distinct from the real CreditLine, and deliberately
/// not implementing its full surface. Used to prove a caller measures what it actually received
/// instead of trusting the requested amount, and that it only depends on a minimal interface.
contract MockUnderfillingCreditLine {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public actualAmount;

    constructor(address token_) {
        token = IERC20(token_);
    }

    /// @notice Test hook: sets the amount `draw` actually pays out, independent of what is asked.
    function setActualAmount(uint256 amount) external {
        actualAmount = amount;
    }

    function draw(uint256) external {
        token.safeTransfer(msg.sender, actualAmount);
    }
}

/// @notice Mock of Doppler's `FeesManager` that mirrors the deployed contract's accounting
/// line-for-line (MasterChef-style cumulated fees per pool, per-beneficiary last-cumulated
/// snapshots and WAD shares):
/// - `collectFees(poolId)` is permissionless, pulls the pool's uncollected LP fees (simulated via
///   the `accrueFees` test hook) into the manager, adds them to the pool's cumulated fees, and
///   then releases ONLY `msg.sender`'s pro-rata share. Every other beneficiary's share stays in
///   the manager until they collect themselves or are touched by `updateBeneficiary`. It returns
///   the pool-wide amounts pulled, not the caller's share.
/// - `updateBeneficiary(poolId, new)` reverts if `new == msg.sender`, releases already-cumulated
///   fees to both parties, snapshots `new` if it had no shares, then moves ALL of the caller's
///   shares to `new`. A caller with 0 shares succeeds as a no-op and still emits the event.
/// - Releases pay each pool currency as ERC20 (or native ETH for `address(0)`) and revert the
///   whole call if the transfer fails, like v4's `CurrencyLibrary.transfer`.
/// - Both mutators share a reentrancy lock, like the real contract's solady `nonReentrant`.
/// - `setCollectReverts(true)` makes `collectFees` revert, standing in for the real
///   `WrongPoolStatus` once a pool has graduated out of `Locked` (where `updateBeneficiary`
///   still works).
contract MockFeesManager is IDopplerFeesManager {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;

    mapping(bytes32 poolId => uint256) public getCumulatedFees0;
    mapping(bytes32 poolId => uint256) public getCumulatedFees1;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256)) public getLastCumulatedFees0;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256)) public getLastCumulatedFees1;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256)) public getShares;

    /// @notice LP fees accrued in the pool's positions but not yet pulled by any `collectFees`.
    mapping(bytes32 poolId => uint256) public uncollectedFees0;
    /// @notice LP fees accrued in the pool's positions but not yet pulled by any `collectFees`.
    mapping(bytes32 poolId => uint256) public uncollectedFees1;

    mapping(bytes32 poolId => PoolKey) internal _poolKeys;
    bool internal _locked;
    bool public collectReverts;

    event Release(bytes32 indexed poolId, address indexed beneficiary, uint256 fees0, uint256 fees1);
    event Collect(bytes32 indexed poolId, uint256 fees0, uint256 fees1);
    event UpdateBeneficiary(bytes32 poolId, address oldBeneficiary, address newBeneficiary);

    error InvalidNewBeneficiary();
    error WrongPoolStatus();
    error Reentrancy();
    error NativeTransferFailed();
    error WrongNativeValue();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// @notice Test hook: registers `poolId`'s key and its initial beneficiaries (shares in WAD).
    function setPool(bytes32 poolId, PoolKey memory key, address[] memory beneficiaries, uint256[] memory shares)
        external
    {
        _poolKeys[poolId] = key;
        for (uint256 i; i < beneficiaries.length; ++i) {
            getShares[poolId][beneficiaries[i]] = shares[i];
        }
    }

    /// @notice Test hook: simulates `amount0`/`amount1` LP fees accruing in the pool's positions.
    /// ERC20 currencies are pulled from the caller (approve first); a native currency must be
    /// attached as `msg.value`.
    function accrueFees(bytes32 poolId, uint256 amount0, uint256 amount1) external payable {
        PoolKey memory key = _poolKeys[poolId];
        uint256 nativeExpected;
        nativeExpected += _pullAccrual(key.currency0, amount0);
        nativeExpected += _pullAccrual(key.currency1, amount1);
        if (msg.value != nativeExpected) revert WrongNativeValue();
        uncollectedFees0[poolId] += amount0;
        uncollectedFees1[poolId] += amount1;
    }

    /// @notice Test hook: makes `collectFees` revert (a graduated pool's `WrongPoolStatus`).
    function setCollectReverts(bool reverts_) external {
        collectReverts = reverts_;
    }

    function collectFees(bytes32 poolId) external nonReentrant returns (uint128 fees0, uint128 fees1) {
        if (collectReverts) revert WrongPoolStatus();

        fees0 = uint128(uncollectedFees0[poolId]);
        fees1 = uint128(uncollectedFees1[poolId]);
        uncollectedFees0[poolId] = 0;
        uncollectedFees1[poolId] = 0;

        getCumulatedFees0[poolId] += fees0;
        getCumulatedFees1[poolId] += fees1;

        _releaseFees(poolId, msg.sender);

        emit Collect(poolId, fees0, fees1);
    }

    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external nonReentrant {
        if (newBeneficiary == msg.sender) revert InvalidNewBeneficiary();

        _releaseFees(poolId, msg.sender);
        _releaseFees(poolId, newBeneficiary);

        if (getShares[poolId][newBeneficiary] == 0) {
            getLastCumulatedFees0[poolId][newBeneficiary] = getCumulatedFees0[poolId];
            getLastCumulatedFees1[poolId][newBeneficiary] = getCumulatedFees1[poolId];
        }

        getShares[poolId][newBeneficiary] += getShares[poolId][msg.sender];
        getShares[poolId][msg.sender] = 0;

        emit UpdateBeneficiary(poolId, msg.sender, newBeneficiary);
    }

    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory) {
        return _poolKeys[poolId];
    }

    /// @notice What `beneficiary` would be paid by a release right now, excluding fees still
    /// uncollected in the pool.
    function pendingInManager(bytes32 poolId, address beneficiary) external view returns (uint256 p0, uint256 p1) {
        uint256 shares = getShares[poolId][beneficiary];
        p0 = (getCumulatedFees0[poolId] - getLastCumulatedFees0[poolId][beneficiary]) * shares / WAD;
        p1 = (getCumulatedFees1[poolId] - getLastCumulatedFees1[poolId][beneficiary]) * shares / WAD;
    }

    function _releaseFees(bytes32 poolId, address beneficiary) internal {
        uint256 shares = getShares[poolId][beneficiary];

        if (shares > 0) {
            PoolKey memory key = _poolKeys[poolId];
            uint256 delta0 = getCumulatedFees0[poolId] - getLastCumulatedFees0[poolId][beneficiary];
            uint256 amount0 = delta0 * shares / WAD;
            getLastCumulatedFees0[poolId][beneficiary] = getCumulatedFees0[poolId];
            if (amount0 > 0) _transfer(key.currency0, beneficiary, amount0);

            uint256 delta1 = getCumulatedFees1[poolId] - getLastCumulatedFees1[poolId][beneficiary];
            uint256 amount1 = delta1 * shares / WAD;
            getLastCumulatedFees1[poolId][beneficiary] = getCumulatedFees1[poolId];
            if (amount1 > 0) _transfer(key.currency1, beneficiary, amount1);

            emit Release(poolId, beneficiary, amount0, amount1);
        }
    }

    function _transfer(address currency, address to, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    function _pullAccrual(address currency, uint256 amount) internal returns (uint256 nativeAmount) {
        if (amount == 0) return 0;
        if (currency == address(0)) return amount;
        IERC20(currency).safeTransferFrom(msg.sender, address(this), amount);
        return 0;
    }
}

/// @notice Mock of Uniswap SwapRouter02 `exactInputSingle`: pulls exactly `amountIn` of
/// `tokenIn` from the caller via `transferFrom` (so it needs an allowance, like the real
/// router), prices the output at a settable `rate` (tokenOut-wei per 1e18 tokenIn-wei), enforces
/// `amountOutMinimum` like the real router's "Too little received" check, and mints `tokenOut`
/// (a `MockERC20`) to `recipient`. Test hooks can make it skip the minimum check and deliver
/// less than it reports, to exercise a caller's own output verification. Records the last call.
contract MockSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    uint256 public rate;
    bool public ignoreMinimum;
    uint256 public deliverBps = BPS;

    uint256 public callCount;
    uint256 public allowanceAtCall;
    ExactInputSingleParams internal _last;

    error TooLittleReceived();

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function setIgnoreMinimum(bool ignore_) external {
        ignoreMinimum = ignore_;
    }

    function setDeliverBps(uint256 deliverBps_) external {
        deliverBps = deliverBps_;
    }

    function last() external view returns (ExactInputSingleParams memory) {
        return _last;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        callCount++;
        _last = params;
        allowanceAtCall = IERC20(params.tokenIn).allowance(msg.sender, address(this));

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        amountOut = params.amountIn * rate / 1e18;
        if (!ignoreMinimum && amountOut < params.amountOutMinimum) revert TooLittleReceived();

        MockERC20(params.tokenOut).mint(params.recipient, amountOut * deliverBps / BPS);
    }
}
