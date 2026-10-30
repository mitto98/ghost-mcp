import { z } from 'zod';
import type { ToolModule } from './context.js';
import type { Json } from '../ghost.js';
import { clean, first, run } from './shared/helpers.js';
import { WRITE } from './shared/params.js';
import { summarizeMember } from './shared/summaries.js';

const shape = {
  id: z.string(),
  name: z.string().optional(),
  note: z.string().max(2000).optional(),
  labels: z.array(z.string()).optional().describe('Replaces the existing labels'),
};

const updateGhostMember: ToolModule = ({ server, ghost, cfg }) => {
  if (!cfg.enableMembers || cfg.readOnly) return;
  server.registerTool(
    'update_ghost_member',
    { title: 'Update a Ghost member', description: "Updates a member's name, note or labels.", inputSchema: shape, annotations: WRITE },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      const { id, labels, ...rest } = a;
      const body: Json = clean(rest);
      if (labels) body.labels = labels.map((name) => ({ name }));
      if (!Object.keys(body).length) throw new Error('Nothing to update: provide at least one field');
      return summarizeMember(first(await ghost.put(`/members/${encodeURIComponent(id)}/`, { members: [body] }), 'members'));
    }),
  );
};

export default updateGhostMember;
