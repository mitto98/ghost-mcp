import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { GhostClient } from '../ghost.js';
import type { ToolContext, ToolModule } from './context.js';
import createGhostMember from './create-ghost-member.js';
import createGhostPage from './create-ghost-page.js';
import createGhostPost from './create-ghost-post.js';
import createGhostTag from './create-ghost-tag.js';
import deleteGhostPage from './delete-ghost-page.js';
import deleteGhostPost from './delete-ghost-post.js';
import deleteGhostTag from './delete-ghost-tag.js';
import getGhostMember from './get-ghost-member.js';
import getGhostPage from './get-ghost-page.js';
import getGhostPost from './get-ghost-post.js';
import getGhostSite from './get-ghost-site.js';
import getGhostTag from './get-ghost-tag.js';
import listGhostMembers from './list-ghost-members.js';
import listGhostNewsletters from './list-ghost-newsletters.js';
import listGhostPages from './list-ghost-pages.js';
import listGhostPosts from './list-ghost-posts.js';
import listGhostTags from './list-ghost-tags.js';
import listGhostTiers from './list-ghost-tiers.js';
import listGhostUsers from './list-ghost-users.js';
import updateGhostMember from './update-ghost-member.js';
import updateGhostPage from './update-ghost-page.js';
import updateGhostPost from './update-ghost-post.js';
import updateGhostTag from './update-ghost-tag.js';
import uploadGhostImage from './upload-ghost-image.js';

/** Every tool, one module each. A module registers itself only if the configuration allows it. */
const modules: ToolModule[] = [
  createGhostMember,
  createGhostPage,
  createGhostPost,
  createGhostTag,
  deleteGhostPage,
  deleteGhostPost,
  deleteGhostTag,
  getGhostMember,
  getGhostPage,
  getGhostPost,
  getGhostSite,
  getGhostTag,
  listGhostMembers,
  listGhostNewsletters,
  listGhostPages,
  listGhostPosts,
  listGhostTags,
  listGhostTiers,
  listGhostUsers,
  updateGhostMember,
  updateGhostPage,
  updateGhostPost,
  updateGhostTag,
  uploadGhostImage,
];

export function registerTools(server: McpServer, ghost: GhostClient, cfg: Config): void {
  const ctx: ToolContext = { server, ghost, cfg };
  for (const register of modules) register(ctx);
}
