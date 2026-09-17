import { describe, expect, it } from "vitest";
import { syncAllowlist } from "../src/policy.js";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("syncAllowlist", () => {
  it("POSTs an allow rule with exactly the given chainIds/addresses/name, no injected defaults", async () => {
    const { fetchImpl, calls } = fakeFetch(201, { id: "policy-1" });

    const result = await syncAllowlist({
      chainIds: [84532],
      addresses: ["0xCard", "0xAgentCard", "0xAdvanceHub"],
      name: "advance-test-allowlist",
      environmentId: "env-123",
      apiToken: "token-abc",
      fetchImpl,
    });

    expect(result.status).toEqual(201);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toEqual("https://app.dynamicauth.com/api/v0/environments/env-123/waas/policies");
    expect(call.init.method).toEqual("POST");
    expect((call.init.headers as Record<string, string>)["Authorization"]).toEqual("Bearer token-abc");

    const body = JSON.parse(call.init.body as string);
    expect(body.rulesToAdd).toHaveLength(1);
    const rule = body.rulesToAdd[0];
    expect(rule.chain).toEqual("EVM");
    expect(rule.chainIds).toEqual([84532]);
    expect(rule.name).toEqual("advance-test-allowlist");
    expect(rule.ruleType).toEqual("allow");
    // exactly what was passed in - no USDC, no defaults added by syncAllowlist itself
    expect(rule.addresses).toEqual(["0xCard", "0xAgentCard", "0xAdvanceHub"]);
  });

  it("never injects a USDC address that the caller did not pass", async () => {
    const { fetchImpl, calls } = fakeFetch(201, {});
    await syncAllowlist({
      chainIds: [84532],
      addresses: ["0xAgentCard"],
      name: "advance-test-no-usdc",
      environmentId: "env-123",
      apiToken: "token-abc",
      fetchImpl,
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.rulesToAdd[0].addresses).toEqual(["0xAgentCard"]);
  });

  it("throws with the response body on a non-2xx status", async () => {
    const { fetchImpl } = fakeFetch(400, { message: "bad request" });
    await expect(
      syncAllowlist({
        chainIds: [84532],
        addresses: ["0xAgentCard"],
        name: "advance-test-fail",
        environmentId: "env-123",
        apiToken: "token-abc",
        fetchImpl,
      }),
    ).rejects.toThrow(/400/);
  });

  it("reads environmentId/apiToken from env vars when not passed explicitly", async () => {
    const { fetchImpl, calls } = fakeFetch(201, {});
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-from-env";
    process.env.DYNAMIC_API_TOKEN = "token-from-env";
    try {
      await syncAllowlist({
        chainIds: [8453],
        addresses: ["0xAgentCard"],
        name: "advance-test-env",
        fetchImpl,
      });
    } finally {
      delete process.env.DYNAMIC_ENVIRONMENT_ID;
      delete process.env.DYNAMIC_API_TOKEN;
    }
    expect(calls[0]!.url).toContain("env-from-env");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toEqual("Bearer token-from-env");
  });

  it("throws when neither explicit nor env-var credentials are available", async () => {
    const { fetchImpl } = fakeFetch(201, {});
    await expect(
      syncAllowlist({ chainIds: [8453], addresses: ["0xAgentCard"], name: "advance-test-missing", fetchImpl }),
    ).rejects.toThrow();
  });
});
