import { type ChildProcess, spawn } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";

/**
 * USDC (FiatTokenV2_2) balanceAndBlacklistStates mapping slot, verified by writing to it
 * on a live anvil fork of Base Sepolia and reading back `balanceOf`.
 */
const USDC_BALANCE_SLOT = 9n;

export interface AnvilFork {
  rpcUrl: string;
  chainId: number;
  stop(): Promise<void>;
  setBalance(address: Address, wei: bigint): Promise<void>;
  setUsdcBalance(usdc: Address, holder: Address, atomicAmount: bigint): Promise<void>;
}

/**
 * Starts an anvil fork of the given RPC (Base Sepolia) on a free local port and waits
 * until it answers eth_chainId. No anvil default/unlocked accounts are used anywhere in
 * these tests (all signer keys are freshly generated), which sidesteps the known "anvil
 * default accounts carry 7702 code on Base forks" gotcha entirely.
 */
export async function startAnvilFork(forkUrl: string, port: number): Promise<AnvilFork> {
  const child: ChildProcess = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent"], {
    stdio: "ignore",
  });

  const rpcUrl = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await publicClient.getChainId();
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (lastError) {
    child.kill();
    throw new Error(`anvil did not become ready on port ${port}: ${String(lastError)}`);
  }

  const rpc = (method: string, params: unknown[]) =>
    (publicClient as unknown as { request(a: { method: string; params: unknown[] }): Promise<unknown> }).request({
      method,
      params,
    });

  return {
    rpcUrl,
    chainId: await publicClient.getChainId(),
    async setBalance(address, wei) {
      await rpc("anvil_setBalance", [address, toHex(wei)]);
    },
    async setUsdcBalance(usdc, holder, atomicAmount) {
      const slot = keccak256(
        encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, USDC_BALANCE_SLOT]),
      );
      await rpc("anvil_setStorageAt", [usdc, slot, pad(toHex(atomicAmount), { size: 32 })]);
    },
    async stop() {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

export { createWalletClient, http as viemHttp };
