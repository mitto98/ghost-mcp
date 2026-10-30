import { z } from 'zod';
import type { ToolModule } from './context.js';
import { clean, first, run } from './shared/helpers.js';
import { WRITE } from './shared/params.js';
import { summarizeTag } from './shared/summaries.js';
import { tagFields } from './shared/tag-fields.js';

const shape = { name: z.string().min(1), ...tagFields };

const createGhostTag: ToolModule = ({ server, ghost, cfg }) => {
  if (cfg.readOnly) return;
  server.registerTool(
    'create_ghost_tag',
    { title: 'Create a Ghost tag', description: 'Creates a tag.', inputSchema: shape, annotations: WRITE },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => summarizeTag(first(await ghost.post('/tags/', { tags: [clean(a)] }), 'tags'))),
  );
};

export default createGhostTag;
