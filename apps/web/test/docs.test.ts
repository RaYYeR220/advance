import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOC_REFS, docExists, readDeployment, readDeployments, readDoc } from "@/lib/docs";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-docs-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readDeployment", () => {
  it("reads a well-formed deployment file", () => {
    fs.writeFileSync(path.join(dir, "84532.json"), JSON.stringify({ hub: `0x${"1".repeat(40)}`, block: 123, owner: `0x${"2".repeat(40)}` }));
    const deployment = readDeployment(84532, dir);
    expect(deployment).toEqual({
      chainId: 84532,
      deployed: true,
      hub: `0x${"1".repeat(40)}`,
      escrowDeployer: undefined,
      loanDeployer: undefined,
      underwriter: undefined,
      owner: `0x${"2".repeat(40)}`,
      block: 123,
    });
  });

  it("reports not deployed when the file is missing", () => {
    expect(readDeployment(8453, dir)).toEqual({ chainId: 8453, deployed: false });
  });

  it("reports not deployed when the file is malformed JSON", () => {
    fs.writeFileSync(path.join(dir, "84532.json"), "{ not json");
    expect(readDeployment(84532, dir)).toEqual({ chainId: 84532, deployed: false });
  });

  it("reports not deployed when hub isn't a well-formed address", () => {
    fs.writeFileSync(path.join(dir, "84532.json"), JSON.stringify({ hub: "not-an-address" }));
    expect(readDeployment(84532, dir)).toEqual({ chainId: 84532, deployed: false });
  });
});

describe("readDeployments", () => {
  it("covers both mainnet and Sepolia regardless of which files exist", () => {
    fs.writeFileSync(path.join(dir, "84532.json"), JSON.stringify({ hub: `0x${"1".repeat(40)}` }));
    const deployments = readDeployments(dir);
    expect(deployments.map((d) => d.chainId)).toEqual([8453, 84532]);
    expect(deployments.find((d) => d.chainId === 8453)?.deployed).toBe(false);
    expect(deployments.find((d) => d.chainId === 84532)?.deployed).toBe(true);
  });
});

describe("readDoc / docExists", () => {
  it("reads an existing doc's source", () => {
    fs.writeFileSync(path.join(dir, "CLAIMS.md"), "# Claims ledger\n\nBody.");
    const doc = readDoc("claims", dir);
    expect(doc?.ref.title).toBe("Claims ledger");
    expect(doc?.source).toContain("Body.");
    expect(docExists("claims", dir)).toBe(true);
  });

  it("is undefined for a file that doesn't exist yet", () => {
    expect(readDoc("proof", dir)).toBeUndefined();
    expect(docExists("proof", dir)).toBe(false);
  });

  it("is undefined for an unrecognized slug", () => {
    expect(readDoc("not-a-real-doc", dir)).toBeUndefined();
  });

  it("declares every doc the plan requires", () => {
    expect(DOC_REFS.map((d) => d.slug).sort()).toEqual(["claims", "judges", "proof", "security"]);
  });
});
