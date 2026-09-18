import { describe, expect, it } from "vitest";
import { parseModelResponse, TOOL_NAMES } from "../../src/brain/tools.js";

describe("parseModelResponse", () => {
  it("accepts a fetch_paid_data tool call", () => {
    const parsed = parseModelResponse(JSON.stringify({ type: "tool", name: "fetch_paid_data", args: { topic: "base-fees" } }));
    expect(parsed).toEqual({ ok: true, value: { type: "tool", name: "fetch_paid_data", args: { topic: "base-fees" } } });
  });

  it("accepts a check_runway tool call with empty args", () => {
    const parsed = parseModelResponse(JSON.stringify({ type: "tool", name: "check_runway", args: {} }));
    expect(parsed).toEqual({ ok: true, value: { type: "tool", name: "check_runway", args: {} } });
  });

  it("accepts a request_credit tool call with empty args", () => {
    const parsed = parseModelResponse(JSON.stringify({ type: "tool", name: "request_credit", args: {} }));
    expect(parsed).toEqual({ ok: true, value: { type: "tool", name: "request_credit", args: {} } });
  });

  it("accepts a final answer", () => {
    const parsed = parseModelResponse(JSON.stringify({ type: "final", content: "the note" }));
    expect(parsed).toEqual({ ok: true, value: { type: "final", content: "the note" } });
  });

  it("rejects an unknown tool name", () => {
    const parsed = parseModelResponse(JSON.stringify({ type: "tool", name: "send_usdc", args: {} }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects a payee smuggled into fetch_paid_data's args", () => {
    const parsed = parseModelResponse(
      JSON.stringify({ type: "tool", name: "fetch_paid_data", args: { topic: "base-fees", payee: "0xdead" } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects an amount smuggled into request_credit's args", () => {
    const parsed = parseModelResponse(
      JSON.stringify({ type: "tool", name: "request_credit", args: { amount: "999999999", payee: "0xdead" } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects malformed JSON without throwing", () => {
    const parsed = parseModelResponse("not json at all");
    expect(parsed.ok).toBe(false);
  });

  it("rejects a well-formed but unrelated JSON shape", () => {
    const parsed = parseModelResponse(JSON.stringify({ hello: "world" }));
    expect(parsed.ok).toBe(false);
  });

  it("exposes exactly the three fixed tool names", () => {
    expect(TOOL_NAMES).toEqual(["fetch_paid_data", "check_runway", "request_credit"]);
  });
});
