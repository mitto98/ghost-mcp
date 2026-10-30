import { z } from 'zod';
import type { ToolModule } from './context.js';
import { first, run } from './shared/helpers.js';
import { READ } from './shared/params.js';
import { summarizeMember } from './shared/summaries.js';

const shape = { id: z.string() };

const getGhostMember: ToolModule = ({ server, ghost, cfg }) => {
  if (!cfg.enableMembers) return;
  server.registerTool(
    'get_ghost_member',
    { title: 'Get a Ghost member', description: 'Fetches one member by id.', inputSchema: shape, annotations: READ },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) =>
      summarizeMember(first(await ghost.get(`/members/${encodeURIComponent(a.id)}/`, { include: 'newsletters,labels,tiers' }), 'members')),
    ),
  );
};

export default getGhostMember;
