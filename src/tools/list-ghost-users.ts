import { z } from 'zod';
import type { ToolModule } from './context.js';
import { names, paginated, run } from './shared/helpers.js';
import { READ, simpleListShape } from './shared/params.js';

const listGhostUsers: ToolModule = ({ server, ghost }) => {
  server.registerTool(
    'list_ghost_users',
    { title: 'List Ghost staff users', description: 'Lists staff users (authors) and their roles.', inputSchema: simpleListShape, annotations: READ },
    run<z.infer<z.ZodObject<typeof simpleListShape>>>(async (a) => {
      const res = await ghost.get('/users/', { ...a, include: 'roles' });
      return paginated('users', res, (u) => ({ id: u.id, name: u.name, slug: u.slug, email: u.email, status: u.status, roles: names(u.roles) }));
    }),
  );
};

export default listGhostUsers;
