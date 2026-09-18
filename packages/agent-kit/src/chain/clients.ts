import {
  createPublicClient,
  createWalletClient,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TransactionSerializable,
  type WalletClient,
} from "viem";
import { toAccount, type LocalAccount } from "viem/accounts";
import type { DynamicKeys } from "../dynamic.js";

/**
 * The subset of {@link DynamicKeys} a signing account needs: resolve a label's address, and sign
 * a transaction with it. Kept independent of the concrete class so tests (and, in principle, any
 * future signer) can supply a fake backed by a local viem private key instead of a real Dynamic
 * MPC wallet - `chain/actions.ts` never imports `DynamicKeys` itself, only this interface.
 */
export type ActionKeys = Pick<DynamicKeys, "address" | "signTransaction">;

/**
 * Builds a viem {@link LocalAccount} for `label` whose `signTransaction` delegates to
 * `keys.signTransaction(label, tx)` - a custom viem `toAccount`, so the wallet client always
 * signs through `DynamicKeys` (or, in tests, an equivalent wrapping a local
 * private key; see `fakeKeysFor` in the fork test). `signMessage`/`signTypedData` are required by
 * viem's `CustomSource` shape but never called by anything in `chain/actions.ts` - every action
 * here sends a plain transaction - so they throw rather than silently doing the wrong thing.
 */
export function dynamicAccount(label: string, address: Address, keys: ActionKeys): LocalAccount {
  return toAccount({
    address,
    async signMessage() {
      throw new Error(`dynamicAccount("${label}"): signMessage is not supported - only signTransaction is used`);
    },
    async signTypedData() {
      throw new Error(`dynamicAccount("${label}"): signTypedData is not supported - only signTransaction is used`);
    },
    signTransaction(transaction: TransactionSerializable): Promise<Hex> {
      return keys.signTransaction(label, transaction);
    },
  });
}

/** A plain viem `PublicClient` for `chain` over `transport` - no built-in RPC default; callers
 * always pass an explicit transport (an anvil fork in tests, a real RPC in production). */
export function publicClientFor(chain: Chain, transport: Transport): PublicClient {
  return createPublicClient({ chain, transport });
}

/**
 * A viem `WalletClient` whose account is `label`'s {@link dynamicAccount}, resolved fresh from
 * `keys` on every call (cheap: one `address()` lookup, no network round trip for most
 * implementations) so a caller never has to worry about a stale cached account.
 */
export async function walletClientFor(params: {
  chain: Chain;
  transport: Transport;
  label: string;
  keys: ActionKeys;
}): Promise<WalletClient<Transport, Chain, LocalAccount>> {
  const address = (await params.keys.address(params.label)) as Address;
  const account = dynamicAccount(params.label, address, params.keys);
  return createWalletClient({ account, chain: params.chain, transport: params.transport });
}
