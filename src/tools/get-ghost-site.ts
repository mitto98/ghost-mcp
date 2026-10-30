import type { ToolModule } from './context.js';
import { run } from './shared/helpers.js';
import { READ } from './shared/params.js';

const getGhostSite: ToolModule = ({ server, ghost, cfg }) => {
  server.registerTool(
    'get_ghost_site',
    {
      title: 'Get Ghost site info',
      description: 'Returns the blog title, description, URL and Ghost version, plus what this MCP server is allowed to do.',
      annotations: READ,
    },
    run(async () => {
      const res = await ghost.get('/site/', undefined, false);
      return {
        ...(res?.site ?? {}),
        mcp: {
          api_version: cfg.apiVersion,
          read_only: cfg.readOnly,
          delete_enabled: cfg.enableDelete && !cfg.readOnly,
          members_enabled: cfg.enableMembers,
        },
      };
    }),
  );
};

export default getGhostSite;
