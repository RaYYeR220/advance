// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {AdvanceHub} from "../src/AdvanceHub.sol";
import {AgentCard} from "../src/AgentCard.sol";
import {EscrowDeployer} from "../src/deployers/EscrowDeployer.sol";
import {LoanDeployer} from "../src/deployers/LoanDeployer.sol";
import {PoolKey} from "../src/interfaces/IDopplerFeesManager.sol";
import {MockERC20, MockFeed, MockFeesManager, MockSwapRouter, MockWETH} from "../test/utils/Mocks.sol";
import {SdkFixtureCCAFactory} from "./sdk/SdkFixtures.sol";

/// @notice Deploys a full, fresh Advance stack (hub plus every dependency AdvanceHub's `Config`
/// needs) for `packages/sdk`'s anvil-fork test suite, and writes every address the TS harness
/// needs to `script/sdk/out/fixture.json`. Doppler/CCA infrastructure is mocked (this SDK task
/// tests the *client's* read/write/encode correctness against Advance's own contracts, not
/// Doppler's or Uniswap's — see `test/utils/Mocks.sol` and `script/sdk/SdkFixtures.sol`); Permit2
/// is the one piece left real, since forking Base gets it for free at its canonical address and
/// the SDK's `bid()` flow is worth exercising against the genuine contract.
/// @dev Run with `forge script script/DeploySdkFixture.s.sol --rpc-url <anvil> --broadcast
/// --private-key <deployer>`, with `UNDERWRITER`, `OWNER`, `TREASURY`, `CARD_OWNER` and `PAYEE`
/// set in the environment (addresses only — this script never needs their private keys).
contract DeploySdkFixture is Script {
    /// @notice Canonical Uniswap Permit2 address — identical on every EVM chain it's deployed to,
    /// including Base (forked here for exactly this).
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 internal constant POOL_ID = keccak256("advance-sdk-fixture-pool");
    uint256 internal constant CREATOR_SHARES = 1e18;

    uint64 internal constant MAX_STALENESS = 3600;
    uint16 internal constant SLIPPAGE_BPS = 100;
    uint256 internal constant MIN_ACTIVITY_USDC = 1_000_000;

    uint256 internal constant PER_CALL_CAP = 50_000e6;
    uint64 internal constant MAX_AUTH_WINDOW = 300;

    string internal constant OUT_PATH = "script/sdk/out/fixture.json";

    function run() external {
        address underwriter = vm.envAddress("UNDERWRITER");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        address cardOwner = vm.envAddress("CARD_OWNER");
        address payee = vm.envAddress("PAYEE");

        vm.startBroadcast();

        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockWETH weth = new MockWETH();
        MockERC20 agentToken = new MockERC20("Agent", "AGT", 18);
        MockFeesManager feesManager = new MockFeesManager();
        MockSwapRouter router = new MockSwapRouter();
        MockFeed ethUsdFeed = new MockFeed();
        ethUsdFeed.setAnswer(2400e8);
        ethUsdFeed.setUpdatedAt(block.timestamp);

        SdkFixtureCCAFactory ccaFactory = new SdkFixtureCCAFactory(PERMIT2);

        EscrowDeployer escrowDeployer = new EscrowDeployer();
        LoanDeployer loanDeployer = new LoanDeployer();

        AdvanceHub hub = new AdvanceHub(
            AdvanceHub.Config({
                usdc: address(usdc),
                weth: address(weth),
                ccaFactory: address(ccaFactory),
                router: address(router),
                ethUsdFeed: address(ethUsdFeed),
                sequencerFeed: address(0),
                reputationRegistry: address(0),
                maxStaleness: MAX_STALENESS,
                slippageBps: SLIPPAGE_BPS,
                minActivityUsdc: MIN_ACTIVITY_USDC
            }),
            underwriter,
            owner,
            escrowDeployer,
            loanDeployer
        );

        address[] memory beneficiaries = new address[](1);
        beneficiaries[0] = treasury;
        uint256[] memory shares = new uint256[](1);
        shares[0] = CREATOR_SHARES;
        (address currency0, address currency1) =
            address(weth) < address(agentToken) ? (address(weth), address(agentToken)) : (address(agentToken), address(weth));
        feesManager.setPool(
            POOL_ID,
            PoolKey({currency0: currency0, currency1: currency1, fee: 0x800000, tickSpacing: 200, hooks: address(0xB0B)}),
            beneficiaries,
            shares
        );

        address[] memory payees = new address[](1);
        payees[0] = payee;
        AgentCard card = new AgentCard(cardOwner, address(hub), address(usdc), PER_CALL_CAP, MAX_AUTH_WINDOW, payees);

        vm.stopBroadcast();

        string memory objectKey = "fixture";
        vm.serializeAddress(objectKey, "hub", address(hub));
        vm.serializeAddress(objectKey, "usdc", address(usdc));
        vm.serializeAddress(objectKey, "weth", address(weth));
        vm.serializeAddress(objectKey, "agentToken", address(agentToken));
        vm.serializeAddress(objectKey, "feesManager", address(feesManager));
        vm.serializeAddress(objectKey, "ccaFactory", address(ccaFactory));
        vm.serializeAddress(objectKey, "router", address(router));
        vm.serializeAddress(objectKey, "ethUsdFeed", address(ethUsdFeed));
        vm.serializeAddress(objectKey, "escrowDeployer", address(escrowDeployer));
        vm.serializeAddress(objectKey, "loanDeployer", address(loanDeployer));
        vm.serializeAddress(objectKey, "agentCard", address(card));
        vm.serializeAddress(objectKey, "permit2", PERMIT2);
        string memory json = vm.serializeBytes32(objectKey, "poolId", POOL_ID);
        vm.writeJson(json, OUT_PATH);
    }
}
