import { z } from 'zod';

/** Fields shared by create_ghost_tag and update_ghost_tag. */
export const tagFields = {
  slug: z.string().optional(),
  description: z.string().max(500).optional(),
  feature_image: z.string().url().optional(),
  visibility: z.enum(['public', 'internal']).optional(),
  meta_title: z.string().max(300).optional(),
  meta_description: z.string().max(500).optional(),
  accent_color: z.string().optional().describe('Hex color without #, e.g. "15171a"'),
};
