import { z } from 'zod';
import type { ToolModule } from './context.js';
import { paginated, run } from './shared/helpers.js';
import { READ, simpleListShape } from './shared/params.js';

const listGhostTiers: ToolModule = ({ server, ghost }) => {
  server.registerTool(
    'list_ghost_tiers',
    { title: 'List Ghost tiers', description: 'Lists membership tiers.', inputSchema: simpleListShape, annotations: READ },
    run<z.infer<z.ZodObject<typeof simpleListShape>>>(async (a) => {
      const res = await ghost.get('/tiers/', a);
      return paginated('tiers', res, (t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        type: t.type,
        active: t.active,
        visibility: t.visibility,
        monthly_price: t.monthly_price,
        yearly_price: t.yearly_price,
        currency: t.currency,
      }));
    }),
  );
};

export default listGhostTiers;
