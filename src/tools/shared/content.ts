import { z } from 'zod';
import type { Json } from '../../ghost.js';
import type { ToolModule } from '../context.js';
import { filterField, limitField, orderField, pageField, chatgptFile, fileParams, DESTRUCTIVE, READ, WRITE } from './params.js';
import { first, joinFilters, paginated, run } from './helpers.js';
import { summarizeContent } from './summaries.js';
import { uploadImage } from './upload.js';

/**
 * Posts and pages share one Admin API shape. Each tool still lives in its own file
 * (e.g. list-ghost-posts.ts); those files just bind one of these builders to a kind.
 */
export type ContentKind = 'post' | 'page';

const info = (kind: ContentKind) => ({
  plural: `${kind}s`,
  base: `/${kind}s/`,
  Kind: kind === 'post' ? 'Post' : 'Page',
});

const contentShape = {
  html: z.string().optional().describe('Body as HTML; Ghost converts it to its Lexical editor format.'),
  lexical: z.string().optional().describe('Body as a Lexical JSON string (advanced). Ignored when html is set.'),
  status: z.enum(['draft', 'published', 'scheduled']).optional().describe('"scheduled" requires a future published_at'),
  slug: z.string().optional(),
  custom_excerpt: z.string().max(300).optional(),
  feature_image: z.string().url().optional().describe('URL of the feature image (see upload_ghost_image)'),
  feature_image_file: chatgptFile.optional().describe('Feature image attached in ChatGPT (e.g. a generated image); uploaded to Ghost and used as feature_image'),
  feature_image_alt: z.string().max(125).optional(),
  feature_image_caption: z.string().optional(),
  featured: z.boolean().optional(),
  visibility: z.enum(['public', 'members', 'paid']).optional(),
  tags: z.array(z.string()).optional().describe('Tag names; missing tags are created. Replaces the existing tags on update.'),
  authors: z.array(z.string()).optional().describe('Author emails or slugs. Replaces the existing authors on update.'),
  published_at: z.string().optional().describe('ISO 8601 date-time'),
  meta_title: z.string().max(300).optional(),
  meta_description: z.string().max(500).optional(),
  canonical_url: z.string().url().optional(),
};

function buildBody(fields: Json): Json {
  const { html, lexical, tags, authors, ...rest } = fields;
  const body: Json = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
  if (html !== undefined) body.html = html;
  else if (lexical !== undefined) body.lexical = lexical;
  if (tags) body.tags = tags.map((name: string) => ({ name }));
  if (authors) body.authors = authors.map((a: string) => (a.includes('@') ? { email: a } : { slug: a }));
  return body;
}

export const defineListContent = (kind: ContentKind): ToolModule => ({ server, ghost }) => {
  const { plural, base } = info(kind);
  const shape = {
    limit: limitField,
    page: pageField,
    status: z.enum(['draft', 'published', 'scheduled', 'sent']).optional().describe('Shortcut for filter "status:<value>"'),
    filter: filterField,
    order: orderField,
    include_content: z.boolean().default(false).describe('Also return each item\'s HTML body (large)'),
  };
  server.registerTool(
    `list_ghost_${plural}`,
    {
      title: `List Ghost ${plural}`,
      description: `Lists ${plural} (all statuses) with pagination. Returns a compact summary per item.`,
      inputSchema: shape,
      annotations: READ,
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      const res = await ghost.get(base, {
        limit: a.limit,
        page: a.page,
        filter: joinFilters(a.status && `status:${a.status}`, a.filter),
        order: a.order,
        include: 'tags,authors',
        formats: a.include_content ? 'html' : undefined,
      });
      return paginated(plural, res, (r) => summarizeContent(r, { html: a.include_content }));
    }),
  );
};

export const defineGetContent = (kind: ContentKind): ToolModule => ({ server, ghost }) => {
  const { plural, base, Kind } = info(kind);
  const shape = {
    id: z.string().optional().describe(`${Kind} id`),
    slug: z.string().optional().describe(`${Kind} slug (alternative to id)`),
    include_lexical: z.boolean().default(false).describe('Also return the raw Lexical JSON'),
  };
  server.registerTool(
    `get_ghost_${kind}`,
    {
      title: `Get a Ghost ${kind}`,
      description: `Fetches one ${kind} by id or slug, including its HTML body.`,
      inputSchema: shape,
      annotations: READ,
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      if (!a.id && !a.slug) throw new Error('Provide id or slug');
      const path = a.id ? `${base}${encodeURIComponent(a.id)}/` : `${base}slug/${encodeURIComponent(a.slug!)}/`;
      const res = await ghost.get(path, { include: 'tags,authors', formats: 'html' });
      return summarizeContent(first(res, plural), { html: true, lexical: a.include_lexical });
    }),
  );
};

export const defineCreateContent = (kind: ContentKind): ToolModule => (ctx) => {
  const { server, ghost, cfg } = ctx;
  if (cfg.readOnly) return;
  const { plural, base } = info(kind);
  const shape = { title: z.string().min(1), ...contentShape };
  server.registerTool(
    `create_ghost_${kind}`,
    {
      title: `Create a Ghost ${kind}`,
      description: `Creates a ${kind}. Defaults to a draft. Does not send any newsletter email.`,
      inputSchema: shape,
      annotations: WRITE,
      ...fileParams('feature_image_file'),
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async ({ feature_image_file, ...a }) => {
      if (feature_image_file) (a as Json).feature_image = await uploadImage(ctx, { file: feature_image_file });
      const body = buildBody(a);
      const res = await ghost.post(base, { [plural]: [body] }, { source: body.html !== undefined ? 'html' : undefined });
      return summarizeContent(first(res, plural));
    }),
  );
};

export const defineUpdateContent = (kind: ContentKind): ToolModule => (ctx) => {
  const { server, ghost, cfg } = ctx;
  if (cfg.readOnly) return;
  const { plural, base, Kind } = info(kind);
  const shape = {
    id: z.string().describe(`${Kind} id (find it with list_ghost_${plural})`),
    title: z.string().min(1).optional(),
    ...contentShape,
    updated_at: z
      .string()
      .optional()
      .describe('Optional optimistic-lock timestamp from a previous read; if it is stale Ghost rejects the update (409). Fetched automatically when omitted.'),
  };
  server.registerTool(
    `update_ghost_${kind}`,
    {
      title: `Update a Ghost ${kind}`,
      description: `Updates the given fields of a ${kind}; omitted fields are unchanged. Setting html replaces the whole body.`,
      inputSchema: shape,
      annotations: WRITE,
      ...fileParams('feature_image_file'),
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async ({ feature_image_file, ...a }) => {
      const { id, updated_at, ...fields } = a;
      if (feature_image_file) (fields as Json).feature_image = await uploadImage(ctx, { file: feature_image_file });
      const body = buildBody(fields);
      if (!Object.keys(body).length) throw new Error('Nothing to update: provide at least one field');
      const path = `${base}${encodeURIComponent(id)}/`;
      const stamp = updated_at ?? first(await ghost.get(path, { fields: 'updated_at' }), plural).updated_at;
      const res = await ghost.put(path, { [plural]: [{ ...body, updated_at: stamp }] }, { source: body.html !== undefined ? 'html' : undefined });
      return summarizeContent(first(res, plural));
    }),
  );
};

export const defineDeleteContent = (kind: ContentKind): ToolModule => ({ server, ghost, cfg }) => {
  if (cfg.readOnly || !cfg.enableDelete) return;
  const { base, Kind } = info(kind);
  const shape = { id: z.string().describe(`${Kind} id`) };
  server.registerTool(
    `delete_ghost_${kind}`,
    {
      title: `Delete a Ghost ${kind}`,
      description: `Permanently deletes a ${kind}. Cannot be undone.`,
      inputSchema: shape,
      annotations: DESTRUCTIVE,
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => {
      await ghost.delete(`${base}${encodeURIComponent(a.id)}/`);
      return { deleted: true, id: a.id };
    }),
  );
};
