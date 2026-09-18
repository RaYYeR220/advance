import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE_ENV = {
  CHAIN_ID: "84532",
  ADVANCE_API_URL: "http://localhost:8787",
  ADVANCE_HUB: "0x4958a4ADbf75AF01dBeE5c2AED5aAcD391c4bdd9",
};

describe("loadConfig — HTTP bind/auth/origin settings", () => {
  it("defaults to a loopback bind with auth not required", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.host).toBe("127.0.0.1");
    expect(config.hostExplicit).toBe(false);
    expect(config.authToken).toBeUndefined();
    expect(config.allowedOriginHostnames).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "::1"]));
  });

  it("marks the host explicit once MCP_BIND_HOST is set, even to the same value", () => {
    const config = loadConfig({ ...BASE_ENV, MCP_BIND_HOST: "127.0.0.1" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.hostExplicit).toBe(true);
  });

  it("carries a non-local MCP_BIND_HOST through as hostExplicit", () => {
    const config = loadConfig({ ...BASE_ENV, MCP_BIND_HOST: "0.0.0.0" });
    expect(config.host).toBe("0.0.0.0");
    expect(config.hostExplicit).toBe(true);
  });

  it("passes MCP_AUTH_TOKEN through without altering it", () => {
    const config = loadConfig({ ...BASE_ENV, MCP_AUTH_TOKEN: "s3cr3t" });
    expect(config.authToken).toBe("s3cr3t");
  });

  it("parses MCP_ALLOWED_ORIGINS (bare hostnames and full origin URLs) alongside the defaults", () => {
    const config = loadConfig({
      ...BASE_ENV,
      MCP_ALLOWED_ORIGINS: "myagent.example.com, https://other.example.com:3000",
    });
    expect(config.allowedOriginHostnames).toEqual(
      expect.arrayContaining(["localhost", "127.0.0.1", "::1", "myagent.example.com", "other.example.com"]),
    );
  });

  it("drops an unparseable MCP_ALLOWED_ORIGINS entry rather than guessing at it", () => {
    const config = loadConfig({ ...BASE_ENV, MCP_ALLOWED_ORIGINS: "https://[bad" });
    expect(config.allowedOriginHostnames).toEqual(["localhost", "127.0.0.1", "::1"]);
  });
});
