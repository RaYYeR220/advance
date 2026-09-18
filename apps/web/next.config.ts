import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  // `/docs` reads contract deployment records and the repository's own write-ups straight off
  // disk (`lib/docs.ts`) — neither is imported, so Next's file tracer wouldn't otherwise bundle
  // them into the deployed function.
  outputFileTracingIncludes: {
    "/docs": ["../../contracts/deployments/**", "../../docs/**"],
    "/docs/[slug]": ["../../docs/**"],
  },
};

export default nextConfig;
