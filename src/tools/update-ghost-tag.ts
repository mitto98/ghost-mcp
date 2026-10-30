import { z } from 'zod';
import type { ToolModule } from './context.js';
import { clean, first, run } from './shared/helpers.js';
import { WRITE } from './shared/params.js';
import { summarizeTag } from './shared/summaries.js';
import { tagFields } from './shared/tag-fields.js';

const shape = { id: z.string(), name: z.string().min(1).optional(), ...tagFields };

const updateGhostTag: ToolModule = ({ server, ghost, cfg }) => {
  if (cfg.readOnly) return;
  server.registerTool(
    'update_ghost_tag',
    { title: 'Update a Ghost tag', description: 'Updates the given fields of a tag.', inputSchema: shape, annotations: WRITE },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      const { id, ...fields } = a;
      const body = clean(fields);
      if (!Object.keys(body).length) throw new Error('Nothing to update: provide at least one field');
      return summarizeTag(first(await ghost.put(`/tags/${encodeURIComponent(id)}/`, { tags: [body] }), 'tags'));
    }),
  );
};

export default updateGhostTag;
