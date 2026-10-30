import { z } from 'zod';
import type { ToolModule } from './context.js';
import { paginated, run } from './shared/helpers.js';
import { READ, simpleListShape } from './shared/params.js';

const listGhostNewsletters: ToolModule = ({ server, ghost }) => {
  server.registerTool(
    'list_ghost_newsletters',
    { title: 'List Ghost newsletters', description: 'Lists newsletters.', inputSchema: simpleListShape, annotations: READ },
    run<z.infer<z.ZodObject<typeof simpleListShape>>>(async (a) => {
      const res = await ghost.get('/newsletters/', a);
      return paginated('newsletters', res, (n) => ({ id: n.id, name: n.name, slug: n.slug, description: n.description, status: n.status, visibility: n.visibility }));
    }),
  );
};

export default listGhostNewsletters;
