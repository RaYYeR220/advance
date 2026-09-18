// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {AdvanceHub} from "../src/AdvanceHub.sol";
import {EscrowDeployer} from "../src/deployers/EscrowDeployer.sol";
import {LoanDeployer} from "../src/deployers/LoanDeployer.sol";

/// @title DeployHub
/// @notice Deploys `EscrowDeployer`, `LoanDeployer` and `AdvanceHub` (in that order) against
/// whatever RPC it is pointed at, broadcasting from the caller's `--private-key`. Every
/// configuration value comes from the environment, so the same script deploys against a real
/// chain or an anvil fork without edits.
/// @dev Run with `forge script script/DeployHub.s.sol:DeployHub --rpc-url <rpc> --broadcast
/// --private-key <pk>`. Reads the deployed addresses back from the broadcast artifact
/// (`broadcast/DeployHub.s.sol/<chainId>/run-latest.json`) - this script itself only logs them.
contract DeployHub is Script {
    function run() external returns (AdvanceHub hub, EscrowDeployer escrowDeployer, LoanDeployer loanDeployer) {
        AdvanceHub.Config memory cfg = AdvanceHub.Config({
            usdc: vm.envAddress("HUB_USDC"),
            weth: vm.envAddress("HUB_WETH"),
            ccaFactory: vm.envAddress("HUB_CCA_FACTORY"),
            router: vm.envAddress("HUB_ROUTER"),
            ethUsdFeed: vm.envAddress("HUB_ETH_USD_FEED"),
            sequencerFeed: vm.envOr("HUB_SEQUENCER_FEED", address(0)),
            reputationRegistry: vm.envOr("HUB_REPUTATION_REGISTRY", address(0)),
            maxStaleness: uint64(vm.envOr("HUB_MAX_STALENESS", uint256(3600))),
            slippageBps: uint16(vm.envOr("HUB_SLIPPAGE_BPS", uint256(100))),
            minActivityUsdc: vm.envOr("HUB_MIN_ACTIVITY_USDC", uint256(1_000_000))
        });
        address underwriter = vm.envAddress("HUB_UNDERWRITER");
        address owner = vm.envAddress("HUB_OWNER");

        vm.startBroadcast();
        escrowDeployer = new EscrowDeployer();
        loanDeployer = new LoanDeployer();
        hub = new AdvanceHub(cfg, underwriter, owner, escrowDeployer, loanDeployer);
        vm.stopBroadcast();

        console2.log("AdvanceHub", address(hub));
        console2.log("EscrowDeployer", address(escrowDeployer));
        console2.log("LoanDeployer", address(loanDeployer));
    }
}
