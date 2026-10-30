import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { GhostClient } from '../ghost.js';

export interface ToolContext {
  server: McpServer;
  ghost: GhostClient;
  cfg: Config;
}

/**
 * One tool per module: registers its tool on the server, or does nothing when the
 * configuration (READ_ONLY, ENABLE_DELETE, ENABLE_MEMBERS) says it must not exist.
 */
export type ToolModule = (ctx: ToolContext) => void;
