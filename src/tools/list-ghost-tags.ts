import { z } from 'zod';
import type { ToolModule } from './context.js';
import { paginated, run } from './shared/helpers.js';
import { filterField, limitField, orderField, pageField, READ } from './shared/params.js';
import { summarizeTag } from './shared/summaries.js';

const shape = { limit: limitField, page: pageField, filter: filterField, order: orderField };

const listGhostTags: ToolModule = ({ server, ghost }) => {
  server.registerTool(
    'list_ghost_tags',
    {
      title: 'List Ghost tags',
      description: 'Lists tags with their post counts.',
      inputSchema: shape,
      annotations: READ,
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      const res = await ghost.get('/tags/', { ...a, include: 'count.posts' });
      return paginated('tags', res, summarizeTag);
    }),
  );
};

export default listGhostTags;
