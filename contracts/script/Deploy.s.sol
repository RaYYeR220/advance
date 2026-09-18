// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {AdvanceHub} from "../src/AdvanceHub.sol";
import {EscrowDeployer} from "../src/deployers/EscrowDeployer.sol";
import {LoanDeployer} from "../src/deployers/LoanDeployer.sol";

/// @title Deploy
/// @notice Deploys one chain's AdvanceHub, plus the EscrowDeployer and LoanDeployer it takes as
/// constructor immutables, from the configuration at `script/config/<chainid>.json`. Writes the
/// result to `deployments/<chainid>.json`.
/// @dev Run with `forge script script/Deploy.s.sol --rpc-url <url> --broadcast`, with
/// `UNDERWRITER_ADDRESS` and `OWNER_ADDRESS` set in the environment. Every address the config names
/// (other than an optional zero `sequencerFeed`) must already have code on the target chain, or the
/// run reverts before anything is deployed -- the on-chain equivalent of the `cast code` check every
/// address in `script/config/84532.json` was verified with before that file was written.
contract Deploy is Script {
    /// @notice Thrown when a configured address has no code on the target chain.
    /// @param field The config field name.
    /// @param addr The empty address.
    error NoCode(string field, address addr);

    /// @notice Deploys the hub for `block.chainid`'s configuration.
    /// @return hub The deployed AdvanceHub.
    function run() external returns (AdvanceHub hub) {
        string memory chainId = vm.toString(block.chainid);
        string memory json = vm.readFile(string.concat("script/config/", chainId, ".json"));

        AdvanceHub.Config memory cfg = _readConfig(json);
        _requireDeployed(cfg);

        address underwriter = vm.envAddress("UNDERWRITER_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");

        vm.startBroadcast();
        EscrowDeployer escrowDeployer = new EscrowDeployer();
        LoanDeployer loanDeployer = new LoanDeployer();
        hub = new AdvanceHub(cfg, underwriter, owner, escrowDeployer, loanDeployer);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("EscrowDeployer", address(escrowDeployer));
        console2.log("LoanDeployer", address(loanDeployer));
        console2.log("AdvanceHub", address(hub));
        console2.log("underwriter", underwriter);
        console2.log("owner", owner);

        _writeDeployment(chainId, hub, escrowDeployer, loanDeployer, underwriter, owner, json);
    }

    /// @dev Reads the hub's constructor configuration out of a `script/config/<chainid>.json` blob.
    function _readConfig(string memory json) internal pure returns (AdvanceHub.Config memory cfg) {
        cfg = AdvanceHub.Config({
            usdc: vm.parseJsonAddress(json, ".usdc"),
            weth: vm.parseJsonAddress(json, ".weth"),
            ccaFactory: vm.parseJsonAddress(json, ".ccaFactory"),
            router: vm.parseJsonAddress(json, ".router"),
            ethUsdFeed: vm.parseJsonAddress(json, ".ethUsdFeed"),
            sequencerFeed: vm.parseJsonAddress(json, ".sequencerFeed"),
            reputationRegistry: vm.parseJsonAddress(json, ".reputationRegistry"),
            // forge-lint: disable-next-line(unsafe-typecast) config values are curated, not user input
            maxStaleness: uint64(vm.parseJsonUint(json, ".maxStaleness")),
            // forge-lint: disable-next-line(unsafe-typecast) config values are curated, not user input
            slippageBps: uint16(vm.parseJsonUint(json, ".slippageBps")),
            minActivityUsdc: vm.parseJsonUint(json, ".minActivityUsdc")
        });
    }

    /// @dev Reverts `NoCode` unless every address the hub is configured with already has code on
    /// this chain. `sequencerFeed` is exempt when it is the zero address (Base Sepolia has none;
    /// `RevenueEscrow` skips the check for a zero feed).
    function _requireDeployed(AdvanceHub.Config memory cfg) internal view {
        _requireCode("usdc", cfg.usdc);
        _requireCode("weth", cfg.weth);
        _requireCode("ccaFactory", cfg.ccaFactory);
        _requireCode("router", cfg.router);
        _requireCode("ethUsdFeed", cfg.ethUsdFeed);
        _requireCode("reputationRegistry", cfg.reputationRegistry);
        if (cfg.sequencerFeed != address(0)) _requireCode("sequencerFeed", cfg.sequencerFeed);
    }

    function _requireCode(string memory field, address addr) internal view {
        if (addr.code.length == 0) revert NoCode(field, addr);
    }

    /// @dev Writes `deployments/<chainid>.json`: the deployed addresses alongside the exact
    /// configuration blob the hub was built from.
    function _writeDeployment(
        string memory chainId,
        AdvanceHub hub,
        EscrowDeployer escrowDeployer,
        LoanDeployer loanDeployer,
        address underwriter,
        address owner,
        string memory configJson
    ) internal {
        string memory out = string.concat(
            '{"hub":"',
            vm.toString(address(hub)),
            '","escrowDeployer":"',
            vm.toString(address(escrowDeployer)),
            '","loanDeployer":"',
            vm.toString(address(loanDeployer)),
            '","underwriter":"',
            vm.toString(underwriter),
            '","owner":"',
            vm.toString(owner),
            '","block":',
            vm.toString(block.number),
            ',"config":',
            configJson,
            "}"
        );
        string memory outPath = string.concat("deployments/", chainId, ".json");
        vm.writeJson(out, outPath);
        console2.log("wrote", outPath);
    }
}
