// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {EscrowDeployer} from "./deployers/EscrowDeployer.sol";
import {LoanDeployer} from "./deployers/LoanDeployer.sol";
import {IAdvance} from "./interfaces/IAdvance.sol";
import {IAdvanceHub} from "./interfaces/IAdvanceHub.sol";
import {IAgentCard} from "./interfaces/IAgentCard.sol";
import {AuctionParameters, ICCA, ICCAFactory} from "./interfaces/ICCA.sol";
import {IDopplerFeesManager, PoolKey} from "./interfaces/IDopplerFeesManager.sol";
import {IReputationRegistry} from "./interfaces/IERC8004.sol";
import {TermSheet, TermSheetLib} from "./lib/TermSheetLib.sol";
import {CreditLine} from "./CreditLine.sol";
import {RevenueEscrow} from "./RevenueEscrow.sol";
import {RevenueNote} from "./RevenueNote.sol";

/// @title AdvanceHub
/// @notice Entry point and registry for Advance loans: revenue-backed credit for agents whose
/// token pools pay Doppler fees. The agent treasury points its fee-beneficiary shares at the
/// escrow predicted for an underwriter-signed TermSheet and calls `openLoan`, which verifies the
/// EIP-712 signature and terms, deploys the loan's escrow, credit line and revenue note, and sells
/// the note through a Uniswap CCA whose proceeds go to the credit line. The hub then drives the
/// loan through settlement, repayment, default or abort, and writes the outcome back to the
/// agent's ERC-8004 reputation.
/// @dev The owner can only rotate the underwriter and hand over ownership in two steps; no
/// function lets the owner move loan funds or change loan terms. Optional external hooks (the
/// agent card, the reputation registry) never block a loan's lifecycle: they are guarded by code
/// checks and low-level calls, and a failure only emits an event. Loan contracts are created by
/// the hub itself through the linked `EscrowDeployer` and `LoanDeployer` libraries, which hold
/// their creation code outside the hub's own initcode.
contract AdvanceHub is EIP712, IAdvance, IAdvanceHub {
    /// @notice Immutable deployment configuration.
    /// @param usdc USDC token loans are raised, drawn and repaid in.
    /// @param weth WETH token; the pool leg fees are underwritten against.
    /// @param ccaFactory Uniswap CCA factory the note auctions are created through.
    /// @param router Uniswap SwapRouter02 escrows swap WETH fees through.
    /// @param ethUsdFeed Chainlink ETH/USD feed bounding escrow swaps.
    /// @param sequencerFeed Chainlink L2 sequencer uptime feed; `address(0)` skips the check.
    /// @param reputationRegistry ERC-8004 reputation registry; without code, feedback is skipped.
    /// @param maxStaleness Maximum age, in seconds, of the ETH/USD price escrows accept.
    /// @param slippageBps Swap slippage escrows allow below the oracle price, in basis points.
    /// @param minActivityUsdc Fee-derived USDC an escrow must repay before its default timer moves.
    struct Config {
        address usdc;
        address weth;
        address ccaFactory;
        address router;
        address ethUsdFeed;
        address sequencerFeed;
        address reputationRegistry;
        uint64 maxStaleness;
        uint16 slippageBps;
        uint256 minActivityUsdc;
    }

    /// @notice A loan's record.
    /// @param ts The signed term sheet the loan was opened with.
    /// @param escrow The loan's RevenueEscrow.
    /// @param note The loan's RevenueNote.
    /// @param creditLine The loan's CreditLine.
    /// @param auction The CCA auction the note is sold through.
    /// @param status Current lifecycle status.
    /// @param openedAt Timestamp of `openLoan`.
    /// @param activatedAt Timestamp the auction settled as graduated (0 until then).
    struct Loan {
        TermSheet ts;
        address escrow;
        address note;
        address creditLine;
        address auction;
        LoanStatus status;
        uint64 openedAt;
        uint64 activatedAt;
    }

    /// @notice CCA tick spacing: $0.01 per note, as a Q96 price in USDC-wei per note-wei.
    uint256 public constant TICK_SPACING_Q96 = uint256(1e4 << 96) / 1e18;

    /// @dev CCA issuance schedules sum to exactly this many mps (milli-basis-points of supply).
    uint256 internal constant MPS_TOTAL = 1e7;
    /// @dev Note-wei per USDC-wei of repayment cap (notes have 18 decimals, USDC 6).
    uint256 internal constant USDC_SCALE = 1e12;
    /// @dev Smallest note supply a term sheet may issue (one whole note).
    uint256 internal constant MIN_NOTE_SUPPLY = 1e18;
    /// @dev Highest floor, in cents per note: the floor never exceeds the $1 of repayment a note claims.
    uint16 internal constant MAX_FLOOR_CENTS = 100;
    /// @dev ERC-8004 feedback value posted when a loan is repaid.
    int128 internal constant REPAID_FEEDBACK = 100;
    /// @dev ERC-8004 feedback value posted when a loan defaults.
    int128 internal constant DEFAULT_FEEDBACK = -100;

    /// @notice USDC token loans are raised, drawn and repaid in.
    address internal immutable usdc;
    /// @notice WETH token; the pool leg fees are underwritten against.
    address internal immutable weth;
    /// @notice Uniswap CCA factory.
    address internal immutable ccaFactory;
    /// @notice Uniswap SwapRouter02 passed to escrows.
    address internal immutable router;
    /// @notice Chainlink ETH/USD feed passed to escrows.
    address internal immutable ethUsdFeed;
    /// @notice Chainlink sequencer uptime feed passed to escrows.
    address internal immutable sequencerFeed;
    /// @notice ERC-8004 reputation registry.
    address internal immutable reputationRegistry;
    /// @notice Maximum ETH/USD price age passed to escrows.
    uint64 internal immutable maxStaleness;
    /// @notice Swap slippage passed to escrows.
    uint16 internal immutable slippageBps;
    /// @notice Default-timer activity threshold passed to escrows.
    uint256 internal immutable minActivityUsdc;

    /// @notice The owner; may only rotate `underwriter` and transfer ownership.
    address public owner;
    /// @notice The address `transferOwnership` nominated, until it calls `acceptOwnership`.
    address public pendingOwner;
    /// @notice The key whose EIP-712 signature `openLoan` requires on a term sheet.
    address public underwriter;
    /// @notice Number of loans opened; also the id of the latest loan (ids start at 1).
    uint256 public loanCount;

    /// @dev Loan records by id.
    mapping(uint256 loanId => Loan) internal _loans;
    /// @notice The loan id opened for a term sheet's EIP-712 struct hash (0 if never opened).
    mapping(bytes32 termSheetHash => uint256 loanId) public loanIdOf;
    /// @notice Whether an underwriter's nonce has been consumed by an opened loan.
    mapping(address signer => mapping(uint256 nonce => bool)) public nonceUsed;

    /// @notice Emitted when a loan is opened and its contracts are wired.
    /// @param loanId The new loan id.
    /// @param termSheetHash The term sheet's EIP-712 struct hash.
    /// @param agentTreasury The borrower of record.
    /// @param escrow The loan's escrow.
    /// @param note The loan's revenue note.
    /// @param creditLine The loan's credit line.
    /// @param auction The note's CCA auction.
    event LoanOpened(
        uint256 indexed loanId,
        bytes32 indexed termSheetHash,
        address indexed agentTreasury,
        address escrow,
        address note,
        address creditLine,
        address auction
    );
    /// @notice Emitted when a loan's auction settles as graduated and its escrow starts repaying.
    /// @param loanId The loan id.
    /// @param principal USDC principal the credit line swept from the auction.
    event LoanActivated(uint256 indexed loanId, uint256 principal);
    /// @notice Emitted when a loan's auction settles without graduating and its escrow is released.
    /// @param loanId The loan id.
    event LoanFailed(uint256 indexed loanId);
    /// @notice Emitted when a loan's note is repaid up to its cap.
    /// @param loanId The loan id.
    /// @param totalRepaid USDC distributed to the note over the loan's life.
    event LoanRepaid(uint256 indexed loanId, uint256 totalRepaid);
    /// @notice Emitted when a delinquent loan is marked defaulted.
    /// @param loanId The loan id.
    /// @param lastRevenueAt The escrow's last revenue timestamp the default was measured from.
    event LoanDefaulted(uint256 indexed loanId, uint64 lastRevenueAt);
    /// @notice Emitted when a never-opened term sheet's escrow is released after its deadline.
    /// @param termSheetHash The term sheet's EIP-712 struct hash.
    event LoanAborted(bytes32 indexed termSheetHash);
    /// @notice Emitted when ERC-8004 feedback about a loan's outcome is recorded.
    /// @param loanId The loan id.
    /// @param agentId The agent's ERC-8004 id.
    /// @param value The feedback value (100 repaid, -100 default).
    /// @param tag The outcome tag ("repaid" or "default").
    event ReputationPosted(uint256 indexed loanId, uint256 indexed agentId, int128 value, string tag);
    /// @notice Emitted when outcome feedback is not recorded: no agent id, no registry code, or the
    /// registry call failed.
    /// @param loanId The loan id.
    /// @param reason The registry's revert data (empty when the call was not attempted).
    event ReputationSkipped(uint256 indexed loanId, bytes reason);
    /// @notice Emitted when a card hook could not run: the card has no code or the call failed.
    /// @param loanId The loan id.
    /// @param selector The card function that was skipped.
    event CardHookSkipped(uint256 indexed loanId, bytes4 selector);
    /// @notice Emitted when an attempt to close a loan contract reverted and was swallowed.
    /// @param loanId The loan id.
    /// @param target The contract whose close reverted (the escrow or the credit line).
    /// @param reason The revert data.
    event CloseAttemptFailed(uint256 indexed loanId, address indexed target, bytes reason);
    /// @notice Emitted when the underwriter key changes.
    /// @param previousUnderwriter The replaced key (zero at deployment).
    /// @param newUnderwriter The new key.
    event UnderwriterUpdated(address indexed previousUnderwriter, address indexed newUnderwriter);
    /// @notice Emitted when the owner nominates a new owner.
    /// @param currentOwner The current owner.
    /// @param newPendingOwner The nominated owner (zero cancels a nomination).
    event OwnershipTransferStarted(address indexed currentOwner, address indexed newPendingOwner);
    /// @notice Emitted when ownership changes.
    /// @param previousOwner The previous owner (zero at deployment).
    /// @param newOwner The new owner.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Thrown when `openLoan` is not called by the term sheet's agent treasury.
    error NotBorrower();
    /// @notice Thrown when `openLoan` is called after the term sheet's deadline.
    error Expired();
    /// @notice Thrown when the underwriter's nonce was already used by an opened loan.
    error NonceUsed();
    /// @notice Thrown when the signature does not recover to the current underwriter.
    error BadSignature();
    /// @notice Thrown when the term sheet's values are out of range.
    /// @param code 1 auction length, 2 floor, 3 note supply, 4 minimum principal, 5 draw limit,
    /// draw period or grace period, 6 expected shares.
    error BadTerms(uint8 code);
    /// @notice Thrown when the term sheet's pool does not have WETH as one of its currencies.
    error NotWethPool();
    /// @notice Thrown when the term sheet's card is not a contract wired to this hub and USDC with
    /// at least one payee and a nonzero owner.
    error InvalidCard();
    /// @notice Thrown when the escrow does not hold the fee shares the loan requires.
    /// @param shares The escrow's actual shares.
    /// @param expected The minimum shares required at this point.
    error EscrowNotBeneficiary(uint256 shares, uint256 expected);
    /// @notice Thrown when a loan callback does not come from that loan's own contract.
    error NotLoanContract();
    /// @notice Thrown when the loan's status does not allow the call.
    /// @param status The loan's actual status.
    error WrongStatus(LoanStatus status);
    /// @notice Thrown when `markDefault` is called before the grace period has passed.
    /// @param eligibleAt The timestamp after which the loan can be marked defaulted.
    error NotDelinquent(uint64 eligibleAt);
    /// @notice Thrown when `abort` is called before the term sheet's deadline has passed.
    error NotExpired();
    /// @notice Thrown when `abort` is called for a term sheet that opened a loan.
    error AlreadyOpened();
    /// @notice Thrown when a caller other than `owner` calls an owner-only function.
    error NotOwner();
    /// @notice Thrown when a caller other than `pendingOwner` calls `acceptOwnership`.
    error NotPendingOwner();
    /// @notice Thrown when a required address is zero.
    error ZeroAddress();

    /// @dev Reverts `ZeroAddress` if any of `usdc`, `weth`, `ccaFactory`, `router`, `ethUsdFeed`,
    /// `underwriter_` or `owner_` is zero.
    /// @param cfg Immutable deployment configuration.
    /// @param underwriter_ The initial underwriter key.
    /// @param owner_ The initial owner.
    constructor(Config memory cfg, address underwriter_, address owner_) EIP712("Advance", "1") {
        if (
            cfg.usdc == address(0) || cfg.weth == address(0) || cfg.ccaFactory == address(0) || cfg.router == address(0)
                || cfg.ethUsdFeed == address(0) || underwriter_ == address(0) || owner_ == address(0)
        ) revert ZeroAddress();

        usdc = cfg.usdc;
        weth = cfg.weth;
        ccaFactory = cfg.ccaFactory;
        router = cfg.router;
        ethUsdFeed = cfg.ethUsdFeed;
        sequencerFeed = cfg.sequencerFeed;
        reputationRegistry = cfg.reputationRegistry;
        maxStaleness = cfg.maxStaleness;
        slippageBps = cfg.slippageBps;
        minActivityUsdc = cfg.minActivityUsdc;

        owner = owner_;
        underwriter = underwriter_;
        emit OwnershipTransferred(address(0), owner_);
        emit UnderwriterUpdated(address(0), underwriter_);
    }

    // ---------------------------------------------------------------------------------------
    // term sheets and escrows
    // ---------------------------------------------------------------------------------------

    /// @notice The EIP-712 digest the underwriter signs for `ts` (domain "Advance", version "1",
    /// this chain, this hub).
    /// @param ts The term sheet.
    /// @return The typed-data digest.
    function termSheetDigest(TermSheet calldata ts) external view returns (bytes32) {
        return _hashTypedDataV4(TermSheetLib.structHash(ts));
    }

    /// @notice The escrow address for `ts`: CREATE2 with the term sheet's struct hash as salt. The
    /// agent treasury points its fee shares here before calling `openLoan`.
    /// @param ts The term sheet.
    /// @return The predicted escrow address.
    function predictEscrow(TermSheet calldata ts) public view returns (address) {
        return EscrowDeployer.predict(_escrowConfig(ts), TermSheetLib.structHash(ts), address(this));
    }

    /// @notice Deploys the escrow for `ts` at `predictEscrow(ts)` if it is not deployed yet.
    /// Callable by anyone; idempotent.
    /// @param ts The term sheet.
    /// @return The escrow address.
    function deployEscrow(TermSheet calldata ts) public returns (address) {
        return _deployEscrow(ts, TermSheetLib.structHash(ts));
    }

    // ---------------------------------------------------------------------------------------
    // lifecycle
    // ---------------------------------------------------------------------------------------

    /// @notice Opens a loan from an underwriter-signed term sheet. Only callable by the term
    /// sheet's agent treasury, at or before its deadline, once per underwriter nonce. Checks, in
    /// order: caller, deadline, nonce, signature, term ranges, WETH pool, card, then that the
    /// escrow holds at least `expectedShares`. Deploys the credit line and note, creates the CCA
    /// auction with the credit line as funds and tokens recipient, mints the note supply into the
    /// auction, and wires the credit line, note and escrow to each other.
    /// @param ts The term sheet.
    /// @param signature The underwriter's 65-byte ECDSA signature over `termSheetDigest(ts)`.
    /// @return loanId The new loan id.
    function openLoan(TermSheet calldata ts, bytes calldata signature) external returns (uint256 loanId) {
        if (msg.sender != ts.agentTreasury) revert NotBorrower();
        // forge-lint: disable-next-line(block-timestamp) the term sheet deadline is a timestamp by design
        if (block.timestamp > ts.deadline) revert Expired();
        address signer = underwriter;
        if (nonceUsed[signer][ts.nonce]) revert NonceUsed();
        bytes32 termSheetHash = TermSheetLib.structHash(ts);
        (address recovered, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(_hashTypedDataV4(termSheetHash), signature);
        if (recoverError != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();

        _checkTerms(ts);
        _checkPool(ts);
        _checkCard(ts.agentCard);

        address escrow = _deployEscrow(ts, termSheetHash);
        uint256 shares = IDopplerFeesManager(ts.feesManager).getShares(ts.poolId, escrow);
        // `expectedShares` is nonzero (BadTerms 6), so this also requires shares > 0.
        if (shares < ts.expectedShares) revert EscrowNotBeneficiary(shares, ts.expectedShares);

        nonceUsed[signer][ts.nonce] = true;
        loanId = ++loanCount;
        loanIdOf[termSheetHash] = loanId;

        address creditLine =
            LoanDeployer.deployCreditLine(usdc, ts.agentCard, ts.agentTreasury, ts.drawLimit, ts.drawPeriod);
        address note = LoanDeployer.deployNote(loanId, usdc);
        address auction = ICCAFactory(ccaFactory)
            .create(note, ts.noteSupply, abi.encode(_auctionParameters(ts, creditLine)), bytes32(loanId));

        Loan storage loan_ = _loans[loanId];
        loan_.ts = ts;
        loan_.escrow = escrow;
        loan_.note = note;
        loan_.creditLine = creditLine;
        loan_.auction = auction;
        loan_.status = LoanStatus.Auction;
        // forge-lint: disable-next-line(unsafe-typecast) timestamps fit in 64 bits
        loan_.openedAt = uint64(block.timestamp);

        // The contract addresses are only known once deployed; the calls so far went to this hub's
        // own deployer libraries and the configured CCA factory.
        // forge-lint: disable-next-line(reentrancy-events)
        emit LoanOpened(loanId, termSheetHash, ts.agentTreasury, escrow, note, creditLine, auction);

        RevenueNote(note).mint(auction, ts.noteSupply);
        ICCA(auction).onTokensReceived();
        CreditLine(creditLine).initialize(loanId, auction, note);
        RevenueNote(note).initialize(escrow, creditLine);
        RevenueEscrow(payable(escrow)).bind(loanId, note, creditLine);
    }

    /// @inheritdoc IAdvanceHub
    /// @dev Only the loan's own credit line, only while the loan is in Auction. Graduated: requires
    /// the escrow to still hold fee shares, marks the loan Active and activates the escrow.
    /// Otherwise: marks the loan Failed and releases the escrow's shares back to the treasury.
    /// Reads the credit line's `principal` but never calls a mutating function on it.
    function onAuctionSettled(uint256 loanId, bool graduated) external {
        Loan storage loan_ = _loans[loanId];
        if (msg.sender != loan_.creditLine) revert NotLoanContract();
        if (loan_.status != LoanStatus.Auction) revert WrongStatus(loan_.status);
        RevenueEscrow escrow = RevenueEscrow(payable(loan_.escrow));

        if (graduated) {
            uint256 shares = IDopplerFeesManager(loan_.ts.feesManager).getShares(loan_.ts.poolId, address(escrow));
            if (shares == 0) revert EscrowNotBeneficiary(0, 1);
            loan_.status = LoanStatus.Active;
            // forge-lint: disable-next-line(unsafe-typecast) timestamps fit in 64 bits
            loan_.activatedAt = uint64(block.timestamp);
            emit LoanActivated(loanId, CreditLine(msg.sender).principal());
            escrow.activate();
        } else {
            loan_.status = LoanStatus.Failed;
            emit LoanFailed(loanId);
            escrow.release();
        }
    }

    /// @inheritdoc IAdvanceHub
    /// @dev Only the loan's own escrow, only while the loan is Active or Defaulted. Active: marks
    /// it Repaid and closes the credit line, sending its undrawn balance to the treasury (a
    /// reverting close is swallowed). Defaulted: marks it Repaid and leaves the frozen credit line
    /// alone. Either way unfreezes the card (funds stay with the agent) and posts +100 "repaid"
    /// feedback; neither hook can revert this call.
    function onRepaid(uint256 loanId) external {
        Loan storage loan_ = _loans[loanId];
        if (msg.sender != loan_.escrow) revert NotLoanContract();
        LoanStatus status = loan_.status;
        if (status != LoanStatus.Active && status != LoanStatus.Defaulted) revert WrongStatus(status);

        loan_.status = LoanStatus.Repaid;
        emit LoanRepaid(loanId, RevenueNote(loan_.note).totalRepaid());

        if (status == LoanStatus.Active) {
            address creditLine = loan_.creditLine;
            try CreditLine(creditLine).close() {}
            catch (bytes memory reason) {
                // forge-lint: disable-next-line(reentrancy-events) the failure is only known after the call
                emit CloseAttemptFailed(loanId, creditLine, reason);
            }
        }
        _callCard(loanId, loan_.ts.agentCard, abi.encodeCall(IAgentCard.unfreeze, ()));
        _postFeedback(loanId, loan_.ts, REPAID_FEEDBACK, "repaid");
    }

    /// @notice Marks an Active loan defaulted once its escrow has gone longer than the grace period
    /// without revenue. Callable by anyone. Freezes the card and returns its USDC to the credit
    /// line, freezes the credit line (its balance goes to noteholders up to the cap, the rest to
    /// the treasury), posts -100 "default" feedback, and closes the escrow if that already filled
    /// the cap (which re-enters `onRepaid` and ends the loan Repaid). The escrow keeps repaying
    /// noteholders from fees otherwise. A failing card hook, registry call or escrow close never
    /// reverts the default.
    /// @param loanId The loan id.
    function markDefault(uint256 loanId) external {
        Loan storage loan_ = _loans[loanId];
        if (loan_.status != LoanStatus.Active) revert WrongStatus(loan_.status);
        RevenueEscrow escrow = RevenueEscrow(payable(loan_.escrow));
        uint64 lastRevenueAt = escrow.lastRevenueAt();
        uint64 eligibleAt = lastRevenueAt + loan_.ts.gracePeriod;
        // forge-lint: disable-next-line(block-timestamp) the grace period is measured in seconds by design
        if (block.timestamp <= eligibleAt) revert NotDelinquent(eligibleAt);

        loan_.status = LoanStatus.Defaulted;
        emit LoanDefaulted(loanId, lastRevenueAt);

        address creditLine = loan_.creditLine;
        address card = loan_.ts.agentCard;
        _callCard(loanId, card, abi.encodeCall(IAgentCard.freeze, ()));
        _callCard(loanId, card, abi.encodeCall(IAgentCard.returnFunds, (creditLine)));
        CreditLine(creditLine).freeze();
        _postFeedback(loanId, loan_.ts, DEFAULT_FEEDBACK, "default");
        try escrow.closeIfRepaid() returns (bool) {}
        catch (bytes memory reason) {
            // forge-lint: disable-next-line(reentrancy-events) the failure is only known after the call
            emit CloseAttemptFailed(loanId, address(escrow), reason);
        }
    }

    /// @notice Releases the escrow of a term sheet that never opened a loan, returning its fee
    /// shares and balances to the agent treasury. Callable by anyone after the deadline; deploys
    /// the escrow first if needed.
    /// @param ts The term sheet.
    function abort(TermSheet calldata ts) external {
        bytes32 termSheetHash = TermSheetLib.structHash(ts);
        if (loanIdOf[termSheetHash] != 0) revert AlreadyOpened();
        // forge-lint: disable-next-line(block-timestamp) the term sheet deadline is a timestamp by design
        if (block.timestamp <= ts.deadline) revert NotExpired();

        emit LoanAborted(termSheetHash);
        RevenueEscrow(payable(_deployEscrow(ts, termSheetHash))).release();
    }

    // ---------------------------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------------------------

    /// @notice A loan's record (all zero, status None, for an unknown id).
    /// @param loanId The loan id.
    /// @return The loan record.
    function loan(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    /// @notice The hub's immutable deployment configuration.
    /// @return The configuration.
    function config() external view returns (Config memory) {
        return Config({
            usdc: usdc,
            weth: weth,
            ccaFactory: ccaFactory,
            router: router,
            ethUsdFeed: ethUsdFeed,
            sequencerFeed: sequencerFeed,
            reputationRegistry: reputationRegistry,
            maxStaleness: maxStaleness,
            slippageBps: slippageBps,
            minActivityUsdc: minActivityUsdc
        });
    }

    // ---------------------------------------------------------------------------------------
    // administration
    // ---------------------------------------------------------------------------------------

    /// @notice Replaces the underwriter key. Only callable by the owner. Loans already opened are
    /// unaffected; term sheets signed by the previous key can no longer be opened.
    /// @param newUnderwriter The new underwriter key; must be nonzero.
    function setUnderwriter(address newUnderwriter) external {
        if (msg.sender != owner) revert NotOwner();
        if (newUnderwriter == address(0)) revert ZeroAddress();
        emit UnderwriterUpdated(underwriter, newUnderwriter);
        underwriter = newUnderwriter;
    }

    /// @notice Nominates `newOwner`, who becomes owner once it calls `acceptOwnership`. Only
    /// callable by the owner; nominating zero cancels a pending nomination.
    /// @param newOwner The nominated owner.
    // forge-lint: disable-next-line(missing-zero-check) zero is how a nomination is cancelled
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(msg.sender, newOwner);
    }

    /// @notice Completes an ownership transfer. Only callable by the pending owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    // ---------------------------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------------------------

    /// @dev Deploys (or finds) the escrow for `ts` salted by its struct hash.
    function _deployEscrow(TermSheet calldata ts, bytes32 termSheetHash) internal returns (address) {
        return EscrowDeployer.deploy(_escrowConfig(ts), termSheetHash);
    }

    /// @dev The escrow configuration for `ts`: this hub, the term sheet's pool and treasury, and
    /// the hub's swap and oracle settings.
    function _escrowConfig(TermSheet calldata ts) internal view returns (RevenueEscrow.Config memory) {
        return RevenueEscrow.Config({
            hub: address(this),
            feesManager: ts.feesManager,
            poolId: ts.poolId,
            treasury: ts.agentTreasury,
            usdc: usdc,
            weth: weth,
            router: router,
            ethUsdFeed: ethUsdFeed,
            sequencerFeed: sequencerFeed,
            maxStaleness: maxStaleness,
            slippageBps: slippageBps,
            minActivityUsdc: minActivityUsdc
        });
    }

    /// @dev Reverts `BadTerms(code)` on the first out-of-range group of term sheet values.
    function _checkTerms(TermSheet calldata ts) internal pure {
        if (ts.auctionBlocks == 0 || MPS_TOTAL % ts.auctionBlocks != 0) revert BadTerms(1);
        if (ts.floorCents == 0 || ts.floorCents > MAX_FLOOR_CENTS) revert BadTerms(2);
        if (ts.noteSupply < MIN_NOTE_SUPPLY || ts.noteSupply % USDC_SCALE != 0) revert BadTerms(3);
        // The most the auction can raise at its floor. `noteSupply` is a multiple of USDC_SCALE
        // (BadTerms 3), so dividing first loses nothing.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 maxAtFloor = ts.noteSupply / USDC_SCALE * ts.floorCents / 100;
        if (ts.minPrincipal == 0 || ts.minPrincipal > maxAtFloor) revert BadTerms(4);
        if (ts.drawLimit == 0 || ts.drawPeriod == 0 || ts.gracePeriod == 0) revert BadTerms(5);
        if (ts.expectedShares == 0) revert BadTerms(6);
    }

    /// @dev Reverts `NotWethPool` unless WETH is one of the pool's two currencies.
    function _checkPool(TermSheet calldata ts) internal view {
        PoolKey memory key = IDopplerFeesManager(ts.feesManager).getPoolKey(ts.poolId);
        if (key.currency0 != weth && key.currency1 != weth) revert NotWethPool();
    }

    /// @dev Reverts `InvalidCard` unless `card` is a contract reporting this hub, this hub's USDC,
    /// a nonzero owner and a nonempty payee list. A getter that reverts or returns malformed data
    /// counts as invalid, and no more than one word of any getter's return data is ever copied.
    function _checkCard(address card) internal view {
        if (card.code.length == 0) revert InvalidCard();
        (bool hubOk, uint256 cardHub) = _readWord(card, IAgentCard.hub.selector, 0);
        (bool usdcOk, uint256 cardUsdc) = _readWord(card, IAgentCard.usdc.selector, 0);
        (bool ownerOk, uint256 cardOwner) = _readWord(card, IAgentCard.owner.selector, 0);
        // `payees()` returns an ABI-encoded dynamic array: a head offset, then the length there.
        (bool headOk, uint256 payeesOffset) = _readWord(card, IAgentCard.payees.selector, 0);
        (bool lengthOk, uint256 payeeCount) = _readWord(card, IAgentCard.payees.selector, payeesOffset);
        if (
            !(hubOk && usdcOk && ownerOk && headOk && lengthOk) || cardHub != uint256(uint160(address(this)))
                || cardUsdc != uint256(uint160(usdc)) || cardOwner == 0 || cardOwner > type(uint160).max
                || payeeCount == 0
        ) revert InvalidCard();
    }

    /// @dev Static-calls `target` with `selector` and no arguments, and reads the word at `offset`
    /// of the return data. `ok` is false if the call reverts or the return data has no full word
    /// at `offset`. Only that word is copied; the call data is built in scratch space.
    function _readWord(address target, bytes4 selector, uint256 offset) internal view returns (bool ok, uint256 word) {
        assembly ("memory-safe") {
            mstore(0x00, selector)
            ok := staticcall(gas(), target, 0x00, 0x04, 0x00, 0x00)
            ok := and(ok, iszero(or(gt(offset, returndatasize()), gt(add(offset, 0x20), returndatasize()))))
            if ok {
                returndatacopy(0x00, offset, 0x20)
                word := mload(0x00)
            }
        }
    }

    /// @dev CCA parameters for `ts`: USDC raised into `creditLine`, which also takes unsold notes;
    /// starts next block and releases the supply evenly over `auctionBlocks`; claimable at the end;
    /// $0.01 ticks with the floor at `floorCents`; graduates at `minPrincipal`; no validation hook.
    function _auctionParameters(TermSheet calldata ts, address creditLine)
        internal
        view
        returns (AuctionParameters memory)
    {
        // forge-lint: disable-next-line(unsafe-typecast) block numbers fit in 64 bits
        uint64 startBlock = uint64(block.number) + 1;
        uint64 endBlock = startBlock + ts.auctionBlocks;
        return AuctionParameters({
            currency: usdc,
            tokensRecipient: creditLine,
            fundsRecipient: creditLine,
            startBlock: startBlock,
            endBlock: endBlock,
            claimBlock: endBlock,
            tickSpacing: TICK_SPACING_Q96,
            validationHook: address(0),
            floorPrice: uint256(ts.floorCents) * TICK_SPACING_Q96,
            requiredCurrencyRaised: ts.minPrincipal,
            // `auctionBlocks` divides 1e7 (BadTerms 1), so both values fit: mps <= 1e7 < 2^24 and
            // blocks <= 1e7 < 2^40.
            // forge-lint: disable-next-line(unsafe-typecast)
            auctionStepsData: abi.encodePacked(uint24(MPS_TOTAL / ts.auctionBlocks), uint40(ts.auctionBlocks))
        });
    }

    /// @dev Calls an optional card hook without ever reverting: skipped when the card has no code,
    /// and a failed call is ignored. Return data is never copied. Emits `CardHookSkipped` with the
    /// hook's selector in both cases.
    function _callCard(uint256 loanId, address card, bytes memory data) internal {
        bool ok = false;
        if (card.code.length != 0) {
            assembly ("memory-safe") {
                ok := call(gas(), card, 0, add(data, 0x20), mload(data), 0, 0)
            }
        }
        if (!ok) {
            // The outcome is only known after the call; `bytes4` keeps the calldata's selector.
            // forge-lint: disable-next-line(reentrancy-events,unsafe-typecast)
            emit CardHookSkipped(loanId, bytes4(data));
        }
    }

    /// @dev Posts ERC-8004 feedback about the loan's outcome without ever reverting: skipped when
    /// the term sheet has no agent id or the registry has no code, and a failed call is reported
    /// with its revert data.
    function _postFeedback(uint256 loanId, TermSheet storage ts, int128 value, string memory tag) internal {
        address registry = reputationRegistry;
        uint256 agentId = ts.agentId;
        if (agentId == 0 || registry.code.length == 0) {
            // forge-lint: disable-next-line(reentrancy-events) emitted by callbacks that follow other loan calls
            emit ReputationSkipped(loanId, "");
            return;
        }
        (bool ok, bytes memory reason) = registry.call(
            abi.encodeCall(IReputationRegistry.giveFeedback, (agentId, value, 0, "advance", tag, "", "", ts.memoHash))
        );
        // The outcome is only known after the call.
        // forge-lint: disable-next-line(reentrancy-events)
        if (ok) emit ReputationPosted(loanId, agentId, value, tag);
        // forge-lint: disable-next-line(reentrancy-events)
        else emit ReputationSkipped(loanId, reason);
    }
}
