import { describe, expect, it } from "vitest";
import { parseEventsQuery } from "@/app/api/events/route";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseEventsQuery", () => {
  it("returns an empty query for no params", () => {
    const result = parseEventsQuery(params(""));
    expect(result).toEqual({ query: { loanId: undefined, types: undefined, sinceSeconds: undefined, limit: undefined, cursor: undefined } });
  });

  it("parses loanId as a bigint", () => {
    const result = parseEventsQuery(params("loanId=42"));
    expect("query" in result && result.query.loanId).toBe(42n);
  });

  it("rejects a non-numeric loanId", () => {
    const result = parseEventsQuery(params("loanId=abc"));
    expect(result).toEqual({ error: "loanId must be a non-negative integer" });
  });

  it("splits and trims a comma-separated types list", () => {
    const result = parseEventsQuery(params("types=Harvested, LoanRepaid ,Claimed"));
    expect("query" in result && result.query.types).toEqual(["Harvested", "LoanRepaid", "Claimed"]);
  });

  it("parses sinceSeconds and rejects a non-numeric value", () => {
    expect("query" in parseEventsQuery(params("sinceSeconds=123")) && (parseEventsQuery(params("sinceSeconds=123")) as { query: { sinceSeconds?: number } }).query.sinceSeconds).toBe(123);
    expect(parseEventsQuery(params("sinceSeconds=nope"))).toEqual({ error: "sinceSeconds must be a number" });
  });

  it("parses and caps limit at 200", () => {
    const result = parseEventsQuery(params("limit=50"));
    expect("query" in result && result.query.limit).toBe(50);
    const capped = parseEventsQuery(params("limit=10000"));
    expect("query" in capped && capped.query.limit).toBe(200);
  });

  it("rejects a non-positive limit", () => {
    expect(parseEventsQuery(params("limit=0"))).toEqual({ error: "limit must be a positive integer" });
    expect(parseEventsQuery(params("limit=-5"))).toEqual({ error: "limit must be a positive integer" });
    expect(parseEventsQuery(params("limit=1.5"))).toEqual({ error: "limit must be a positive integer" });
  });

  it("passes cursor through untouched", () => {
    const result = parseEventsQuery(params("cursor=abc123"));
    expect("query" in result && result.query.cursor).toBe("abc123");
  });
});
