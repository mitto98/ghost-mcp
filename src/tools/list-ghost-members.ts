import { z } from 'zod';
import type { ToolModule } from './context.js';
import { paginated, run } from './shared/helpers.js';
import { limitField, orderField, pageField, READ } from './shared/params.js';
import { summarizeMember } from './shared/summaries.js';

const shape = {
  limit: limitField,
  page: pageField,
  filter: z.string().optional().describe('NQL filter, e.g. "status:paid" or "label:vip"'),
  search: z.string().optional().describe('Match on name or email'),
  order: orderField,
};

const listGhostMembers: ToolModule = ({ server, ghost, cfg }) => {
  if (!cfg.enableMembers) return;
  server.registerTool(
    'list_ghost_members',
    { title: 'List Ghost members', description: 'Lists members (contains personal data).', inputSchema: shape, annotations: READ },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      const res = await ghost.get('/members/', { ...a, include: 'newsletters,labels' });
      return paginated('members', res, summarizeMember);
    }),
  );
};

export default listGhostMembers;
