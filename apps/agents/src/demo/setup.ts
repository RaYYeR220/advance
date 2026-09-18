import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { chainAddresses } from "@advance/core";
import {
  createLiveDynamicClient,
  DynamicKeys,
  EventStore,
  FileStore,
  type ActionContext,
  type ActionKeys,
} from "@advance/agent-kit";
import { combinedKeys } from "../chain/localKeys.js";
import { LocalKeyCustody, type KeyCustody } from "../chain/localCustody.js";

const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** The one Sepolia deployment + the fixed set of local/env-derived actors this demo drives. */
export interface DemoEnv {
  chainId: 84532;
  rpcUrl: string;
  publicClient: PublicClient;
  hub: Address;
  usdc: Address;
  weth: Address;
  permit2: Address;
  identityRegistry: Address;
  reputationRegistryAddress: Address;
  feesManager: Address;
  poolManager: Address;
  sepoliaSwapper: Address;
  deployerAddress: Address;
  deployerPrivateKey: `0x${string}`;
  /** A second, dedicated key for lender/keeper actions (bid, settle, harvest, markDefault,
   * claim) - kept separate from the deployer key purely to avoid nonce contention with whatever
   * else concurrently sends from the deployer address (provisioning, token launches). */
  bidderAddress: Address;
  bidderPrivateKey: `0x${string}`;
  underwriterPrivateKey: `0x${string}`;
  underwriterAddress: Address;
  servicePayTo: Address;
  storeDir: string;
  store: FileStore;
  /** Agent treasury/card-owner key custody. `KEY_CUSTODY=dynamic` selects a real Dynamic MPC
   * client; the default (`local`) selects {@link LocalKeyCustody} - see its doc comment for why. */
  dynamicKeys: KeyCustody;
  events: EventStore;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

/**
 * Builds every shared dependency the demo bins need: a real live-Dynamic-backed `DynamicKeys`
 * (only ever imported here - never at module load time elsewhere, so nothing on the Windows host
 * accidentally pulls in the Linux-only native MPC module), a Base Sepolia `PublicClient`, the
 * deployment's fixed addresses, and the on-disk store/event sink.
 */
export async function loadDemoEnv(): Promise<DemoEnv> {
  const rpcUrl = requireEnv("BASE_SEPOLIA_RPC_URL");
  const hub = requireEnv("ADVANCE_HUB_84532") as Address;
  const deployerAddress = requireEnv("DEPLOYER_ADDRESS") as Address;
  const deployerPrivateKey = requireEnv("DEPLOYER_PRIVATE_KEY") as `0x${string}`;
  const bidderAddress = requireEnv("BIDDER_ADDRESS") as Address;
  const bidderPrivateKey = requireEnv("BIDDER_PRIVATE_KEY") as `0x${string}`;
  const underwriterPrivateKey = requireEnv("UNDERWRITER_PRIVATE_KEY") as `0x${string}`;
  const underwriterAddress = requireEnv("UNDERWRITER_ADDRESS") as Address;
  const servicePayTo = (process.env["SERVICE_PAYTO"] ?? deployerAddress) as Address;
  const storeDir = process.env["AGENT_STORE_DIR"] ?? ".data";
  const sepoliaSwapper = requireEnv("SEPOLIA_SWAPPER_84532") as Address;

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const addresses = chainAddresses(84532);

  const store = new FileStore(storeDir);
  const custody = process.env["KEY_CUSTODY"] ?? "local";
  const dynamicKeys: KeyCustody =
    custody === "dynamic"
      ? new DynamicKeys(
          await createLiveDynamicClient({
            environmentId: requireEnv("DYNAMIC_ENVIRONMENT_ID"),
            apiToken: requireEnv("DYNAMIC_API_TOKEN"),
          }),
          store,
          requireEnv("WALLET_ENCRYPTION_KEY"),
        )
      : new LocalKeyCustody(store, requireEnv("WALLET_ENCRYPTION_KEY"));
  const events = new EventStore(store);

  return {
    chainId: 84532,
    rpcUrl,
    publicClient,
    hub,
    usdc: addresses.usdc,
    weth: addresses.weth,
    permit2: PERMIT2,
    identityRegistry: requireEnv("IDENTITY_REGISTRY_84532") as Address,
    reputationRegistryAddress: requireEnv("REPUTATION_REGISTRY_84532") as Address,
    feesManager: addresses.dopplerFeesManager,
    poolManager: addresses.poolManager,
    sepoliaSwapper,
    deployerAddress,
    deployerPrivateKey,
    bidderAddress,
    bidderPrivateKey,
    underwriterPrivateKey,
    underwriterAddress,
    servicePayTo,
    storeDir,
    store,
    dynamicKeys,
    events,
  };
}

/**
 * The `ActionContext` every `@advance/agent-kit` chain action needs, with signing that resolves
 * `"deployer"` (and any other label in `extraLocalKeys`) to a plain local private key and every
 * other label through the real Dynamic MPC client.
 */
export function buildActionContext(
  env: DemoEnv,
  extraLocalKeys: Record<string, `0x${string}`> = {},
): ActionContext {
  const keys: ActionKeys = combinedKeys(env.dynamicKeys, {
    deployer: env.deployerPrivateKey,
    bidder: env.bidderPrivateKey,
    ...extraLocalKeys,
  });
  return {
    chain: baseSepolia,
    transport: http(env.rpcUrl),
    publicClient: env.publicClient,
    keys,
    addresses: {
      hub: env.hub,
      usdc: env.usdc,
      permit2: env.permit2,
      identityRegistry: env.identityRegistry,
    },
    events: env.events,
  };
}
