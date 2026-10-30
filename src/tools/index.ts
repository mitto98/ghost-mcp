import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { GhostClient } from '../ghost.js';
import type { ToolContext } from './context.js';
import { modules } from './modules.generated.js';

/**
 * Registers every tool in this folder. The list of modules is generated from the folder at build
 * time (scripts/generate-tools.mjs); each module registers itself only if the configuration allows it.
 */
export function registerTools(server: McpServer, ghost: GhostClient, cfg: Config): void {
  const ctx: ToolContext = { server, ghost, cfg };
  for (const register of modules) register(ctx);
}
