import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildAdvanceServer, type AdvanceMcpDeps } from "./server.js";

/** Connects one long-lived `McpServer` to stdin/stdout — the local-integration transport, where
 * the client spawns this process (the `advance-mcp` bin) as a child. Resolves once connected;
 * the process stays alive reading stdin until the client disconnects. */
export async function runStdioServer(deps: AdvanceMcpDeps): Promise<void> {
  const server = buildAdvanceServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
