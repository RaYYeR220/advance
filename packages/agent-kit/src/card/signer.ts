import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import type { DynamicKeys, EvmTypedData } from "../dynamic.js";

const TRANSFER_WITH_AUTHORIZATION = "TransferWithAuthorization";

/** The subset of `DynamicKeys` a card signer needs - just enough to unit test
 * against a fake without pulling in `Store`/encryption. */
export type CardSignerKeys = Pick<DynamicKeys, "signTypedData">;

export interface CardSignerDeps {
  /** Signs on behalf of the card owner. Never sees anything but a validated
   * `TransferWithAuthorization` request `from` this card. */
  keys: CardSignerKeys;
  /** This card's own `usdc()` - the only `verifyingContract` this signer will ever sign for. */
  usdc: Address;
}

/** `@x402/evm`'s `ClientEvmSigner` shape, restated locally so this module doesn't
 * need `@x402/evm` as a dependency just for a type. */
export interface CardSignerHandle {
  readonly address: Address;
  signTypedData(typedData: EvmTypedData): Promise<Hex>;
}

/**
 * Builds an x402 `ClientEvmSigner` whose `address` is the AgentCard, not the owner
 * key: x402 (and the card contract's own EIP-3009 check) sees payments as coming
 * `from` the card. Every `signTypedData` call is validated before the owner key is
 * ever touched - a request for anything but a `TransferWithAuthorization` "from"
 * this card, on USDC, never reaches Dynamic. The card's on-chain payee/cap/window
 * enforcement (`AgentCard.isValidSignature`) is the real backstop; this is just the
 * first place a malformed or off-policy request gets refused instead of signed.
 *
 * The owner signature itself is a plain ECDSA signature over the same EIP-712
 * digest USDC will recompute (see `AgentCard.isValidSignature`) - `ownerLabel`
 * must resolve to a key whose signatures verify against `AgentCard.owner()`
 * (a Dynamic MPC key or any other EOA-style 65-byte v=27/28 signer; never a 7702
 * account).
 */
export function cardSigner(card: Address, ownerLabel: string, deps: CardSignerDeps): CardSignerHandle {
  const address = getAddress(card);
  const usdc = getAddress(deps.usdc);

  return {
    address,
    async signTypedData(typedData: EvmTypedData): Promise<Hex> {
      if (typedData.primaryType !== TRANSFER_WITH_AUTHORIZATION) {
        throw new Error(
          `cardSigner: refusing to sign primaryType "${typedData.primaryType}" (only ${TRANSFER_WITH_AUTHORIZATION})`,
        );
      }

      const verifyingContract = typedData.domain["verifyingContract"];
      if (typeof verifyingContract !== "string" || getAddress(verifyingContract) !== usdc) {
        throw new Error(
          `cardSigner: refusing to sign - domain.verifyingContract (${String(verifyingContract)}) is not this card's USDC (${usdc})`,
        );
      }

      const from = typedData.message["from"];
      if (typeof from !== "string" || getAddress(from) !== address) {
        throw new Error(`cardSigner: refusing to sign - message.from (${String(from)}) is not this card (${address})`);
      }

      const ownerSig = await deps.keys.signTypedData(ownerLabel, typedData);

      const { to, value, validAfter, validBefore, nonce } = typedData.message as {
        to: Address;
        value: bigint | number | string;
        validAfter: bigint | number | string;
        validBefore: bigint | number | string;
        nonce: Hex;
      };

      return encodeAbiParameters(
        [
          { type: "bytes" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [ownerSig, getAddress(to), BigInt(value), BigInt(validAfter), BigInt(validBefore), nonce],
      );
    },
  };
}
