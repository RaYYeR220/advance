// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAgentCard} from "./interfaces/IAgentCard.sol";
import {IFiatToken} from "./interfaces/IFiatToken.sol";
import {CreditLine} from "./CreditLine.sol";

/// @title AgentCard
/// @notice Holds an agent's drawn USDC and approves x402 payments -- EIP-3009
/// `transferWithAuthorization` on USDC, which routes a contract `from` through ERC-1271
/// `isValidSignature` -- only to a fixed, constructor-set payee allowlist, under a per-call cap
/// and a bounded authorization window. Even a compromised owner key or a prompt-injected agent
/// can move this card's USDC nowhere but those payees: there is no generic execute and no owner
/// withdrawal, only allowlisted EIP-3009 transfers and the hub's `returnFunds`.
contract AgentCard is IERC1271, IAgentCard, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes4 internal constant MAGICVALUE = 0x1626ba7e;
    bytes4 internal constant INVALID_SIGNATURE = 0xffffffff;

    /// @notice EIP-712 typehash of USDC's `TransferWithAuthorization` struct.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @inheritdoc IAgentCard
    address public immutable owner;
    /// @inheritdoc IAgentCard
    address public immutable hub;
    /// @inheritdoc IAgentCard
    IERC20 public immutable usdc;
    /// @inheritdoc IAgentCard
    uint256 public immutable perCallCap;
    /// @inheritdoc IAgentCard
    uint64 public immutable maxAuthWindow;

    /// @inheritdoc IAgentCard
    bool public frozen;

    /// @dev Fixed payee allowlist, set once in the constructor; no function ever adds or removes
    /// an entry.
    mapping(address payee => bool) internal _isAllowedPayee;
    /// @dev Same allowlist as `_isAllowedPayee`, kept in constructor order for `payees()`.
    address[] internal _payees;

    /// @param owner_ The agent's signing key; the only address allowed to `drawCredit`.
    /// @param hub_ AdvanceHub address; the only caller allowed to `freeze`, `unfreeze` and
    /// `returnFunds`.
    /// @param usdc_ USDC token this card holds and pays out.
    /// @param perCallCap_ Maximum USDC value a single authorized payment may move.
    /// @param maxAuthWindow_ Maximum seconds beyond `block.timestamp` an authorization's
    /// `validBefore` may be set to at verification time.
    /// @param payees_ Fixed set of payees this card may ever pay; must be nonempty.
    constructor(
        address owner_,
        address hub_,
        address usdc_,
        uint256 perCallCap_,
        uint64 maxAuthWindow_,
        address[] memory payees_
    ) {
        if (owner_ == address(0) || hub_ == address(0) || usdc_ == address(0)) {
            revert ZeroAddress();
        }
        if (payees_.length == 0) revert NoPayees();

        owner = owner_;
        hub = hub_;
        usdc = IERC20(usdc_);
        perCallCap = perCallCap_;
        maxAuthWindow = maxAuthWindow_;

        for (uint256 i; i < payees_.length; ++i) {
            _isAllowedPayee[payees_[i]] = true;
        }
        _payees = payees_;
    }

    /// @notice Validates a USDC `transferWithAuthorization` blob against this card's policy.
    /// @dev `signature` must decode as `abi.encode(bytes ownerSig, address to, uint256 value,
    /// uint256 validAfter, uint256 validBefore, bytes32 nonce)`. Never reverts: a frozen card, a
    /// malformed blob, a disallowed payee, an over-cap value, an authorization window beyond
    /// `maxAuthWindow`, a `hash` that does not match the blob's own fields, or an `ownerSig` that
    /// does not recover to `owner` all return the ERC-1271 invalid selector instead.
    /// @param hash The EIP-712 digest USDC is asking this card to approve.
    /// @param signature The encoded authorization blob described above.
    /// @return The ERC-1271 magic value if valid, otherwise `0xffffffff`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (frozen) return INVALID_SIGNATURE;

        try this.decodeBlob(signature) returns (
            bytes memory ownerSig, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce
        ) {
            if (!_isAllowedPayee[to]) return INVALID_SIGNATURE;
            if (value > perCallCap) return INVALID_SIGNATURE;
            // forge-lint: disable-next-line(block-timestamp) authorization window bound intentionally uses block.timestamp
            if (validBefore > block.timestamp + maxAuthWindow) return INVALID_SIGNATURE;

            bytes32 structHash = keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), to, value, validAfter, validBefore, nonce
                )
            );
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", IFiatToken(address(usdc)).DOMAIN_SEPARATOR(), structHash));
            if (digest != hash) return INVALID_SIGNATURE;

            if (!SignatureChecker.isValidSignatureNow(owner, hash, ownerSig)) return INVALID_SIGNATURE;
            return MAGICVALUE;
        } catch {
            return INVALID_SIGNATURE;
        }
    }

    /// @notice Decodes an `isValidSignature` blob. External and pure so `isValidSignature` can
    /// call it through `try`/`catch` and treat any malformed blob as invalid instead of reverting.
    /// @param signature The encoded authorization blob.
    /// @return ownerSig `owner`'s signature over the EIP-712 digest.
    /// @return to Payee.
    /// @return value USDC-wei to transfer.
    /// @return validAfter Authorization valid-from timestamp.
    /// @return validBefore Authorization valid-until timestamp.
    /// @return nonce EIP-3009 authorization nonce.
    function decodeBlob(bytes calldata signature)
        external
        pure
        returns (
            bytes memory ownerSig,
            address to,
            uint256 value,
            uint256 validAfter,
            uint256 validBefore,
            bytes32 nonce
        )
    {
        return abi.decode(signature, (bytes, address, uint256, uint256, uint256, bytes32));
    }

    /// @inheritdoc IAgentCard
    function drawCredit(address creditLine, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        emit CreditDrawn(creditLine, amount);
        CreditLine(creditLine).draw(amount);
    }

    /// @inheritdoc IAgentCard
    function freeze() external {
        if (msg.sender != hub) revert NotHub();
        frozen = true;
        emit Frozen();
    }

    /// @inheritdoc IAgentCard
    function unfreeze() external {
        if (msg.sender != hub) revert NotHub();
        frozen = false;
        emit Unfrozen();
    }

    /// @inheritdoc IAgentCard
    function returnFunds(address creditLine) external nonReentrant {
        if (msg.sender != hub) revert NotHub();
        uint256 balance = usdc.balanceOf(address(this));
        emit FundsReturned(creditLine, balance);
        if (balance != 0) {
            usdc.safeTransfer(creditLine, balance);
        }
    }

    /// @inheritdoc IAgentCard
    function isAllowedPayee(address payee) external view returns (bool) {
        return _isAllowedPayee[payee];
    }

    /// @inheritdoc IAgentCard
    function payees() external view returns (address[] memory) {
        return _payees;
    }
}
