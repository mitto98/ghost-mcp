import { z } from 'zod';
import type { ToolModule } from './context.js';
import type { Json } from '../ghost.js';
import { first, run } from './shared/helpers.js';
import { WRITE } from './shared/params.js';
import { summarizeMember } from './shared/summaries.js';

const shape = {
  email: z.string().email(),
  name: z.string().optional(),
  note: z.string().max(2000).optional(),
  labels: z.array(z.string()).optional().describe('Label names; missing labels are created'),
};

const createGhostMember: ToolModule = ({ server, ghost, cfg }) => {
  if (!cfg.enableMembers || cfg.readOnly) return;
  server.registerTool(
    'create_ghost_member',
    { title: 'Create a Ghost member', description: 'Adds a member. Sends no email.', inputSchema: shape, annotations: WRITE },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      const { labels, ...rest } = a;
      const body: Json = { ...rest };
      if (labels) body.labels = labels.map((name) => ({ name }));
      return summarizeMember(first(await ghost.post('/members/', { members: [body] }), 'members'));
    }),
  );
};

export default createGhostMember;
