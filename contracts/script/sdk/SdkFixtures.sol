// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AuctionParameters, Checkpoint, ICCA, ICCAFactory} from "../../src/interfaces/ICCA.sol";

/// @notice The slice of Uniswap Permit2's `IAllowanceTransfer` a CCA auction actually calls to
/// pull a bid's currency. Matches the real, already-deployed Permit2 contract's ABI.
interface IPermit2AllowanceTransfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @notice SDK-test-only CCA auction fixture used by `packages/sdk`'s anvil-fork suite.
/// @dev Unlike `test/utils/Mocks.sol`'s `MockAuction` (whose `submitBid` is a no-op and bids are
/// injected through a `recordSale` test hook, since it exists only to exercise AdvanceHub/
/// CreditLine's own settlement plumbing), this implements a real, Permit2-settled `submitBid` so
/// the SDK's bid flow (`USDC.approve(Permit2)` -> `Permit2.approve(auction, ...)` -> `submitBid`)
/// can run end-to-end against a real Permit2 deployment — this fixture only ever runs on a Base
/// fork, where Permit2's canonical address already has real code. CCA economics are deliberately
/// simplified: every bid fills in full at its own `maxPriceQ96` (no price-time clearing, no
/// partial fills, no bid exits) — enough to prove the SDK's calldata and read paths are correct,
/// not a reimplementation of the real auction's clearing mechanism. Graduation is tracked as a
/// monotonic `totalRaised` counter (not a live currency balance), so it stays `true` after
/// `sweepCurrency` empties the contract's balance out — exactly like the real contract, whose
/// `isGraduated()` must still read `true` post-settlement for `CreditLine.settleAuction` to have
/// activated the loan in the first place.
contract SdkFixtureAuction is ICCA {
    using SafeERC20 for IERC20;

    struct SoldLot {
        address owner;
        uint256 amount;
        bool claimed;
    }

    IPermit2AllowanceTransfer internal immutable _permit2;
    IERC20 internal immutable _currency;
    IERC20 internal immutable _noteToken;
    address internal immutable _fundsRecipient;
    address internal immutable _tokensRecipient;
    uint64 internal immutable _endBlock;
    uint128 internal immutable _requiredCurrencyRaised;

    uint256 public totalSold;
    uint256 public totalRaised;
    uint256 public lastClearingPriceQ96;
    mapping(uint256 bidId => SoldLot) internal _soldLots;
    uint256 internal _nextBidId;

    bool public currencySwept;
    bool public unsoldSwept;

    error NotFundsRecipient();
    error NotTokensRecipient();
    error AuctionNotOver();
    error AlreadySwept();
    error NotGraduated();
    error AlreadyClaimed();

    constructor(
        address permit2_,
        address currency_,
        address noteToken_,
        address fundsRecipient_,
        address tokensRecipient_,
        uint64 endBlockNumber_,
        uint128 requiredCurrencyRaised_
    ) {
        _permit2 = IPermit2AllowanceTransfer(permit2_);
        _currency = IERC20(currency_);
        _noteToken = IERC20(noteToken_);
        _fundsRecipient = fundsRecipient_;
        _tokensRecipient = tokensRecipient_;
        _endBlock = endBlockNumber_;
        _requiredCurrencyRaised = requiredCurrencyRaised_;
    }

    function onTokensReceived() external {}

    /// @notice Pulls the bid's worst-case currency cost (`ceil(amount * maxPriceQ96 / Q96)`) from
    /// `owner` via Permit2 and records the fill. `prevTickPriceQ96`/`hookData` are accepted (to
    /// match the real interface) but unused — this fixture has no order book or validation hook.
    function submitBid(uint256 maxPriceQ96, uint128 amount, address owner, uint256, bytes calldata)
        external
        payable
        returns (uint256 bidId)
    {
        uint256 cost = (uint256(amount) * maxPriceQ96 + (1 << 96) - 1) >> 96;
        if (cost != 0) {
            _permit2.transferFrom(owner, address(this), uint160(cost), address(_currency));
        }

        bidId = _nextBidId++;
        _soldLots[bidId] = SoldLot({owner: owner, amount: amount, claimed: false});
        totalSold += amount;
        totalRaised += cost;
        lastClearingPriceQ96 = maxPriceQ96;
    }

    function checkpoint() external returns (Checkpoint memory) {
        return Checkpoint(lastClearingPriceQ96, 0, 0, 0, 0, 0);
    }

    function sweepCurrency() external {
        if (msg.sender != _fundsRecipient) revert NotFundsRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (currencySwept) revert AlreadySwept();
        currencySwept = true;

        if (isGraduated()) {
            uint256 balance = _currency.balanceOf(address(this));
            if (balance != 0) _currency.safeTransfer(_fundsRecipient, balance);
        }
    }

    function sweepUnsoldTokens() external {
        if (msg.sender != _tokensRecipient) revert NotTokensRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (unsoldSwept) revert AlreadySwept();
        unsoldSwept = true;

        uint256 balance = _noteToken.balanceOf(address(this));
        uint256 unsold = isGraduated() ? balance - totalSold : balance;
        if (unsold != 0) _noteToken.safeTransfer(_tokensRecipient, unsold);
    }

    function endBlock() external view returns (uint64) {
        return _endBlock;
    }

    /// @notice Pays out a filled bid's notes to its owner. Only after `endBlock`, only once
    /// graduated, only once per bid.
    function claimTokens(uint256 bidId) external {
        if (block.number < _endBlock) revert AuctionNotOver();
        if (!isGraduated()) revert NotGraduated();
        SoldLot storage lot = _soldLots[bidId];
        if (lot.claimed) revert AlreadyClaimed();
        lot.claimed = true;
        if (lot.amount != 0) _noteToken.safeTransfer(lot.owner, lot.amount);
    }

    function exitBid(uint256) external {}

    function isGraduated() public view returns (bool) {
        return totalRaised >= _requiredCurrencyRaised;
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
}

/// @notice Deploys `SdkFixtureAuction`s, wiring in the real Permit2 address every instance needs.
/// Mirrors `test/utils/Mocks.sol`'s `MockCCAFactory` parameter validation (kept in sync
/// deliberately, not imported, so this fixture never depends on that test file compiling).
contract SdkFixtureCCAFactory is ICCAFactory {
    uint256 internal constant MPS_TOTAL = 1e7;
    uint256 internal constant STEP_BYTES = 8;

    address internal immutable _permit2;

    uint256 public createCount;
    address public lastAuction;

    error InvalidTickSpacing();
    error FloorNotOnTick();
    error StartBlockInPast();
    error InvalidEndBlock();
    error InvalidClaimBlock();
    error InvalidStepsData();
    error SupplyTooLarge();

    constructor(address permit2_) {
        _permit2 = permit2_;
    }

    function create(address token_, uint256 amount, bytes calldata configData, bytes32 salt)
        external
        returns (address auction)
    {
        AuctionParameters memory params = abi.decode(configData, (AuctionParameters));
        _validate(params, amount);

        auction = address(
            new SdkFixtureAuction{salt: _salt(msg.sender, salt)}(
                _permit2,
                params.currency,
                token_,
                params.fundsRecipient,
                params.tokensRecipient,
                params.endBlock,
                params.requiredCurrencyRaised
            )
        );

        createCount++;
        lastAuction = auction;
    }

    function getAddress(address token_, uint256, bytes calldata configData, bytes32 salt, address sender)
        external
        view
        returns (address)
    {
        AuctionParameters memory params = abi.decode(configData, (AuctionParameters));
        bytes memory initCode = abi.encodePacked(
            type(SdkFixtureAuction).creationCode,
            abi.encode(
                _permit2,
                params.currency,
                token_,
                params.fundsRecipient,
                params.tokensRecipient,
                params.endBlock,
                params.requiredCurrencyRaised
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(sender, salt), keccak256(initCode)))
                )
            )
        );
    }

    function _salt(address sender, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(sender, salt));
    }

    function _validate(AuctionParameters memory params, uint256 amount) internal view {
        if (amount > type(uint128).max) revert SupplyTooLarge();
        if (params.tickSpacing == 0) revert InvalidTickSpacing();
        if (params.floorPrice == 0 || params.floorPrice % params.tickSpacing != 0) revert FloorNotOnTick();
        if (params.startBlock < block.number) revert StartBlockInPast();
        if (params.endBlock <= params.startBlock) revert InvalidEndBlock();
        if (params.claimBlock < params.endBlock) revert InvalidClaimBlock();

        bytes memory steps = params.auctionStepsData;
        if (steps.length == 0 || steps.length % STEP_BYTES != 0) revert InvalidStepsData();
        uint256 totalMps;
        uint256 totalBlocks;
        for (uint256 offset; offset < steps.length; offset += STEP_BYTES) {
            uint256 word;
            assembly ("memory-safe") {
                word := mload(add(add(steps, 0x20), offset))
            }
            uint256 mps = word >> 232;
            uint256 blocks = (word >> 192) & type(uint40).max;
            totalMps += mps * blocks;
            totalBlocks += blocks;
        }
        if (totalMps != MPS_TOTAL) revert InvalidStepsData();
        if (params.startBlock + totalBlocks != params.endBlock) revert InvalidStepsData();
    }
}
