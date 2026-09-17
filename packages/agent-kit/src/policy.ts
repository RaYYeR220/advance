const DEFAULT_BASE_URL = "https://app.dynamicauth.com";

export interface SyncAllowlistParams {
  /** EVM chain ids the rule applies to (e.g. [84532] for Base Sepolia). */
  chainIds: number[];
  /**
   * Exact tx allowlist to sync. Passed through verbatim - this function never
   * adds addresses on its own (in particular: never injects USDC; card owners
   * never transfer USDC directly, only via signed EIP-3009 typed data that the
   * card contract itself validates).
   */
  addresses: string[];
  name: string;
  environmentId?: string;
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SyncAllowlistResult {
  status: number;
  body: unknown;
}

/**
 * Syncs one environment-wide Dynamic WaaS "allow" tx-destination rule
 * (`POST /api/v0/environments/{envId}/waas/policies`). Per-wallet policy
 * layers are early access and out of scope here.
 */
export async function syncAllowlist(params: SyncAllowlistParams): Promise<SyncAllowlistResult> {
  const environmentId = params.environmentId ?? process.env.DYNAMIC_ENVIRONMENT_ID;
  const apiToken = params.apiToken ?? process.env.DYNAMIC_API_TOKEN;
  if (!environmentId) {
    throw new Error("syncAllowlist: missing environmentId (pass it or set DYNAMIC_ENVIRONMENT_ID)");
  }
  if (!apiToken) {
    throw new Error("syncAllowlist: missing apiToken (pass it or set DYNAMIC_API_TOKEN)");
  }

  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = `${baseUrl}/api/v0/environments/${environmentId}/waas/policies`;

  const requestBody = {
    rulesToAdd: [
      {
        chain: "EVM",
        chainIds: params.chainIds,
        name: params.name,
        ruleType: "allow",
        addresses: params.addresses,
      },
    ],
  };

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(requestBody),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) {
    throw new Error(`syncAllowlist: Dynamic policy sync failed with ${res.status} ${res.statusText}: ${text}`);
  }

  return { status: res.status, body };
}
