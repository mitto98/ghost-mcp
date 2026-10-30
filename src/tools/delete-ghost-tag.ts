import { z } from 'zod';
import type { ToolModule } from './context.js';
import { run } from './shared/helpers.js';
import { DESTRUCTIVE } from './shared/params.js';

const shape = { id: z.string() };

const deleteGhostTag: ToolModule = ({ server, ghost, cfg }) => {
  if (cfg.readOnly || !cfg.enableDelete) return;
  server.registerTool(
    'delete_ghost_tag',
    { title: 'Delete a Ghost tag', description: 'Permanently deletes a tag.', inputSchema: shape, annotations: DESTRUCTIVE },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      await ghost.delete(`/tags/${encodeURIComponent(a.id)}/`);
      return { deleted: true, id: a.id };
    }),
  );
};

export default deleteGhostTag;
