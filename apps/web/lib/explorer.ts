import { isAddress, isTxHash } from "./format";

export const BASE_MAINNET = 8453;
export const BASE_SEPOLIA = 84532;

interface Explorer {
  name: string;
  origin: string;
}

const EXPLORERS: Readonly<Record<number, Explorer>> = {
  [BASE_MAINNET]: { name: "Base mainnet", origin: "https://basescan.org" },
  [BASE_SEPOLIA]: { name: "Base Sepolia", origin: "https://sepolia.basescan.org" },
};

function explorerFor(chainId: number): Explorer {
  const explorer = EXPLORERS[chainId];
  if (!explorer) throw new RangeError(`no block explorer for chain ${chainId}`);
  return explorer;
}

export function explorerOrigin(chainId: number): string {
  return explorerFor(chainId).origin;
}

export function chainName(chainId: number): string {
  return explorerFor(chainId).name;
}

export function txUrl(chainId: number, hash: string): string {
  if (!isTxHash(hash)) throw new TypeError(`not a transaction hash: ${hash}`);
  return `${explorerOrigin(chainId)}/tx/${hash.toLowerCase()}`;
}

export function addressUrl(chainId: number, address: string): string {
  if (!isAddress(address)) throw new TypeError(`not an address: ${address}`);
  return `${explorerOrigin(chainId)}/address/${address.toLowerCase()}`;
}

export function tokenUrl(chainId: number, address: string): string {
  if (!isAddress(address)) throw new TypeError(`not an address: ${address}`);
  return `${explorerOrigin(chainId)}/token/${address.toLowerCase()}`;
}

export function blockUrl(chainId: number, block: number | bigint): string {
  if (typeof block === "number" ? !Number.isSafeInteger(block) || block < 0 : block < 0n) {
    throw new RangeError(`block must be a non-negative integer, got ${block}`);
  }
  return `${explorerOrigin(chainId)}/block/${block.toString()}`;
}
