"use client";

import type { ReactNode } from "react";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";

export interface DynamicProviderProps {
  environmentId: string;
  children: ReactNode;
}

/** Wraps `children` with Dynamic's wallet context, configured for an EVM (Base) lender
 * wallet. Only ever mounted once an `environmentId` is known — callers missing
 * `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` render a disabled bid form instead of this at all,
 * rather than mounting a provider with an empty id. */
export function DynamicProvider({ environmentId, children }: DynamicProviderProps) {
  return (
    <DynamicContextProvider settings={{ environmentId, walletConnectors: [EthereumWalletConnectors] }}>
      {children}
    </DynamicContextProvider>
  );
}
