import { z } from 'zod';
import type { ToolModule } from './context.js';
import { first, run } from './shared/helpers.js';
import { READ } from './shared/params.js';
import { summarizeTag } from './shared/summaries.js';

const shape = { id: z.string().optional(), slug: z.string().optional() };

const getGhostTag: ToolModule = ({ server, ghost }) => {
  server.registerTool(
    'get_ghost_tag',
    {
      title: 'Get a Ghost tag',
      description: 'Fetches one tag by id or slug.',
      inputSchema: shape,
      annotations: READ,
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      if (!a.id && !a.slug) throw new Error('Provide id or slug');
      const path = a.id ? `/tags/${encodeURIComponent(a.id)}/` : `/tags/slug/${encodeURIComponent(a.slug!)}/`;
      return summarizeTag(first(await ghost.get(path, { include: 'count.posts' }), 'tags'));
    }),
  );
};

export default getGhostTag;
