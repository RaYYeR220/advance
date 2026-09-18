import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { startAnvilFork, type AnvilFork } from "./anvil-fork.js";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "../../../../contracts");

/** Real Base mainnet addresses the deployed hub and the fork test's actions are wired against -
 * see `internal/spikes/cca-8004-oracle-swap` for how each was found/verified live on-chain. */
export const BASE_MAINNET = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  weth: "0x4200000000000000000000000000000000000006" as Address,
  ccaFactory: "0x000000001F26a0044BaA66024e7b6599c61963F8" as Address,
  router: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
  ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
  /** The Ratspeak pool: a real, live, WETH-paired Doppler pool already used as this repo's fixed
   * term sheet vector (see `contracts/test/vectors/termsheet.json`). Its current majority
   * ("creator") beneficiary is `0x96C33027948124a63E885fc34C29692d5A898765` - a real wallet this
   * test does not hold the key for, so the fork test impersonates it once, as setup, to hand the
   * beneficiary role to a treasury key the test does control (see `moveRealPoolBeneficiaryTo`).
   * Everything downstream of that hand-off runs through the real, typed `chain/actions.ts`. */
  ratspeakPool: {
    feesManager: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544" as Address,
    poolId: "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6" as Hex,
    realCreator: "0x96C33027948124a63E885fc34C29692d5A898765" as Address,
  },
};

export interface HubFork {
  fork: AnvilFork;
  publicClient: PublicClient;
  hub: Address;
  escrowDeployer: Address;
  loanDeployer: Address;
}

interface ForgeBroadcastTransaction {
  contractName: string | null;
  contractAddress: string | null;
  transactionType: string;
}

/**
 * Starts an anvil fork of Base mainnet and deploys `EscrowDeployer`, `LoanDeployer` and
 * `AdvanceHub` onto it by running `forge script script/DeployHub.s.sol` against the fork's RPC -
 * exactly as the brief requires, not a direct `viem.deployContract` of the hub. Addresses are read
 * back from the script's broadcast artifact (`broadcast/DeployHub.s.sol/<chainId>/run-latest.json`).
 */
export async function deployHubOnFork(params: {
  forkUrl: string;
  port: number;
  underwriter: Address;
  owner: Address;
  deployerPrivateKey: Hex;
  deployerAddress: Address;
}): Promise<HubFork> {
  const fork = await startAnvilFork(params.forkUrl, params.port);
  const publicClient = createPublicClient({ chain: base, transport: http(fork.rpcUrl) }) as PublicClient;

  await fork.setBalance(params.deployerAddress, 10n ** 18n);

  execFileSync(
    "forge",
    ["script", "script/DeployHub.s.sol:DeployHub", "--rpc-url", fork.rpcUrl, "--broadcast", "--private-key", params.deployerPrivateKey],
    {
      cwd: contractsDir,
      env: {
        ...process.env,
        HUB_USDC: BASE_MAINNET.usdc,
        HUB_WETH: BASE_MAINNET.weth,
        HUB_CCA_FACTORY: BASE_MAINNET.ccaFactory,
        HUB_ROUTER: BASE_MAINNET.router,
        HUB_ETH_USD_FEED: BASE_MAINNET.ethUsdFeed,
        HUB_REPUTATION_REGISTRY: BASE_MAINNET.reputationRegistry,
        // Generous: the fork's block.timestamp can drift from the live oracle's last update once
        // the test warps time forward (e.g. past a loan's grace period); this test cares about
        // proving the action wiring, not tight staleness enforcement.
        HUB_MAX_STALENESS: String(30 * 24 * 3600),
        HUB_SLIPPAGE_BPS: "100",
        HUB_MIN_ACTIVITY_USDC: "100000",
        HUB_UNDERWRITER: params.underwriter,
        HUB_OWNER: params.owner,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const broadcastPath = resolve(contractsDir, `broadcast/DeployHub.s.sol/${fork.chainId}/run-latest.json`);
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8")) as { transactions: ForgeBroadcastTransaction[] };
  const addressOf = (contractName: string): Address => {
    const tx = broadcast.transactions.find((t) => t.contractName === contractName);
    if (!tx?.contractAddress) {
      throw new Error(`deployHubOnFork: no "${contractName}" deployment found in ${broadcastPath}`);
    }
    return tx.contractAddress as Address;
  };

  return {
    fork,
    publicClient,
    hub: addressOf("AdvanceHub"),
    escrowDeployer: addressOf("EscrowDeployer"),
    loanDeployer: addressOf("LoanDeployer"),
  };
}

interface ForgeArtifact {
  abi: readonly unknown[];
  bytecode: { object: Hex };
}

function loadArtifact(contract: string): ForgeArtifact {
  const artifactPath = resolve(contractsDir, `out/${contract}.sol/${contract}.json`);
  try {
    return JSON.parse(readFileSync(artifactPath, "utf8")) as ForgeArtifact;
  } catch (err) {
    throw new Error(`loadArtifact("${contract}"): could not read ${artifactPath} - run "forge build" in contracts/ first (${String(err)})`);
  }
}

export { loadArtifact };
