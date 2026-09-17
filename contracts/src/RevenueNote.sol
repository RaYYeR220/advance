// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title RevenueNote
/// @notice The per-loan ERC20 note. Lenders buy notes at auction; the note receives USDC
/// repayments swept from the agent's fee stream (via `distribute`) and pays them out pro-rata
/// to holders. Accrued-but-unclaimed repayment travels with the note on transfer, so unsold
/// notes held by the auction contract carry their repayment to whoever later claims them.
contract RevenueNote is ERC20, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @dev Fixed-point scale for the accumulator; large enough that per-holder rounding dust
    /// from `amount * ACC_SCALE / totalSupply()` is negligible.
    uint256 internal constant ACC_SCALE = 1e30;

    /// @dev Notes are 18 decimals, USDC is 6; 1e18 note-wei claims on 1e6 USDC-wei.
    uint256 internal constant USDC_SCALE = 1e12;

    address public immutable hub;
    IERC20 public immutable usdc;

    address public escrow;
    address public creditLine;
    bool public initialized;
    bool public minted;

    /// @dev Cumulative USDC distributed per note, scaled by ACC_SCALE.
    uint256 public accPerNote;
    uint256 public totalRepaidAmount;

    /// @dev Per-account snapshot of `accPerNote` as of the last settlement.
    mapping(address => uint256) public snap;
    /// @dev Per-account USDC owed as of the last settlement, not yet reflecting balance changes since.
    mapping(address => uint256) public owed;

    event Distributed(address indexed from, uint256 amount, uint256 totalRepaid);
    event Claimed(address indexed holder, uint256 amount);

    error NotHub();
    error NotDistributor();
    error AlreadyInitialized();
    error ExceedsCap(uint256 amount, uint256 remaining);

    /// @param name_ ERC20 name.
    /// @param symbol_ ERC20 symbol.
    /// @param hub_ AdvanceHub address; the only caller allowed to `initialize` and `mint`.
    /// @param usdc_ USDC token address that repayments are denominated and paid in.
    constructor(string memory name_, string memory symbol_, address hub_, address usdc_) ERC20(name_, symbol_) {
        hub = hub_;
        usdc = IERC20(usdc_);
    }

    /// @notice Wires the escrow and credit line addresses allowed to distribute/burn. Callable once, by the hub.
    /// @param escrow_ RevenueEscrow address, allowed to `distribute`.
    /// @param creditLine_ CreditLine address, allowed to `distribute` and `burn`.
    function initialize(address escrow_, address creditLine_) external {
        if (msg.sender != hub) revert NotHub();
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        escrow = escrow_;
        creditLine = creditLine_;
    }

    /// @notice Mints the fixed note supply to `to`. Callable once, by the hub.
    /// @param to Recipient of the full note supply (typically the auction contract).
    /// @param amount Note supply to mint, 18 decimals.
    function mint(address to, uint256 amount) external {
        if (msg.sender != hub) revert NotHub();
        if (minted) revert AlreadyInitialized();
        minted = true;
        _mint(to, amount);
    }

    /// @notice Burns unsold notes held by the credit line at auction settlement, shrinking the repayment cap.
    /// @param amount Amount of notes to burn from the caller's own balance.
    function burn(uint256 amount) external {
        if (msg.sender != creditLine) revert NotDistributor();
        _burn(msg.sender, amount);
    }

    /// @notice Pulls `usdcAmount` USDC from the caller and distributes it pro-rata to note holders.
    /// @param usdcAmount Amount of USDC to distribute; must not exceed `remainingCap()`.
    function distribute(uint256 usdcAmount) external nonReentrant {
        if (msg.sender != escrow && msg.sender != creditLine) revert NotDistributor();

        uint256 remaining = remainingCap();
        if (usdcAmount > remaining) revert ExceedsCap(usdcAmount, remaining);

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        uint256 supply = totalSupply();
        if (supply != 0) {
            accPerNote += usdcAmount * ACC_SCALE / supply;
        }
        totalRepaidAmount += usdcAmount;

        emit Distributed(msg.sender, usdcAmount, totalRepaidAmount);
    }

    /// @notice Claims the caller's owed USDC, paying the caller.
    /// @return amount The USDC amount paid out.
    function claim() external nonReentrant returns (uint256) {
        return _claim(msg.sender);
    }

    /// @notice Claims `holder`'s owed USDC, paying `holder` regardless of who calls.
    /// @param holder The note holder whose owed USDC is paid out.
    /// @return amount The USDC amount paid out.
    function claimFor(address holder) external nonReentrant returns (uint256) {
        return _claim(holder);
    }

    /// @notice The USDC currently owed to `holder`, including unsettled accrual since their last touch.
    function claimable(address holder) external view returns (uint256) {
        uint256 diff = accPerNote - snap[holder];
        return owed[holder] + balanceOf(holder) * diff / ACC_SCALE;
    }

    /// @notice The total USDC repayment cap for this note (fixed supply / 1e12).
    function capUsdc() public view returns (uint256) {
        return totalSupply() / USDC_SCALE;
    }

    /// @notice The remaining USDC that can still be distributed before hitting the cap.
    function remainingCap() public view returns (uint256) {
        return capUsdc() - totalRepaidAmount;
    }

    /// @notice The cumulative USDC distributed to this note over its lifetime.
    function totalRepaid() external view returns (uint256) {
        return totalRepaidAmount;
    }

    function _claim(address holder) internal returns (uint256) {
        _settle(holder);
        uint256 amount = owed[holder];
        if (amount != 0) {
            owed[holder] = 0;
            usdc.safeTransfer(holder, amount);
            emit Claimed(holder, amount);
        }
        return amount;
    }

    /// @dev Settles `account`'s owed balance up to the current `accPerNote`, using its
    /// balance as of the call (pre-transfer, when invoked from `_update`).
    function _settle(address account) internal {
        if (account == address(0)) return;
        uint256 acc = accPerNote;
        owed[account] += balanceOf(account) * (acc - snap[account]) / ACC_SCALE;
        snap[account] = acc;
    }

    /// @dev Settles both parties before any balance change, then moves the sender's pro-rata
    /// share of its accrued-but-unclaimed owed USDC to the recipient, so unclaimed repayment
    /// travels with the note on transfer.
    function _update(address from, address to, uint256 value) internal override {
        _settle(from);
        _settle(to);

        if (from != address(0) && to != address(0) && value != 0) {
            uint256 fromBalance = balanceOf(from);
            if (fromBalance != 0) {
                uint256 moved = owed[from] * value / fromBalance;
                owed[from] -= moved;
                owed[to] += moved;
            }
        }

        super._update(from, to, value);
    }
}
