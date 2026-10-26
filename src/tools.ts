import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { GhostClient, type Json } from './ghost.js';
import { fetchImage, mimeFromFilename } from './images.js';

const MAX_OUTPUT_CHARS = 80_000;

function text(value: unknown) {
  let out = JSON.stringify(value, null, 2);
  if (out.length > MAX_OUTPUT_CHARS) {
    out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${out.length - MAX_OUTPUT_CHARS} more characters; lower "limit" or narrow the filter]`;
  }
  return { content: [{ type: 'text' as const, text: out }] };
}

function failure(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Wraps a handler so thrown errors become MCP tool errors instead of protocol errors. */
function run<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return failure(e);
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const limitField = z.number().int().min(1).max(100).default(15).describe('Page size (1-100)');
const pageField = z.number().int().min(1).default(1).describe('Page number, starting at 1');
const filterField = z.string().optional().describe('Ghost NQL filter, e.g. "tag:news+status:published" or "featured:true"');
const orderField = z.string().optional().describe('Sort order, e.g. "published_at desc"');

function joinFilters(...parts: (string | undefined)[]): string | undefined {
  const f = parts.filter((p): p is string => !!p);
  if (!f.length) return undefined;
  return f.length === 1 ? f[0] : f.map((p) => `(${p})`).join('+');
}

const names = (xs?: Json[]) => xs?.map((x) => x.name ?? x.slug);

function summarizeContent(r: Json, opts: { html?: boolean; lexical?: boolean } = {}): Json {
  const out: Json = {
    id: r.id,
    title: r.title,
    slug: r.slug,
    status: r.status,
    visibility: r.visibility,
    featured: r.featured,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_at: r.published_at,
    excerpt: r.custom_excerpt ?? r.excerpt,
    feature_image: r.feature_image,
    tags: names(r.tags),
    authors: names(r.authors),
    reading_time: r.reading_time,
  };
  if (opts.html) out.html = r.html;
  if (opts.lexical) out.lexical = r.lexical;
  return out;
}

const summarizeTag = (t: Json): Json => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  description: t.description,
  visibility: t.visibility,
  feature_image: t.feature_image,
  url: t.url,
  posts: t.count?.posts,
});

const summarizeMember = (m: Json): Json => ({
  id: m.id,
  email: m.email,
  name: m.name,
  note: m.note,
  status: m.status,
  subscribed: m.subscribed,
  created_at: m.created_at,
  labels: names(m.labels),
  newsletters: names(m.newsletters),
  tiers: names(m.tiers),
});

function paginated(key: string, res: Json | null, map: (x: Json) => Json) {
  return { [key]: (res?.[key] ?? []).map(map), pagination: res?.meta?.pagination };
}

function first(res: Json | null, key: string): Json {
  const item = res?.[key]?.[0];
  if (!item) throw new Error(`Ghost returned no ${key} item`);
  return item;
}

const chatgptFile = z
  .object({
    download_url: z.string().url(),
    file_id: z.string().optional(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .describe('A file attached in ChatGPT (including images it generated); ChatGPT fills this in automatically.');
type ChatgptFile = z.infer<typeof chatgptFile>;

/** Tells ChatGPT these parameters take attached files, which it then sends as {download_url, file_id}. */
const fileParams = (...names: string[]) => ({ _meta: { 'openai/fileParams': names } });

export function registerTools(server: McpServer, ghost: GhostClient, cfg: Config): void {
  /** Uploads an image to Ghost from a ChatGPT file, a URL or base64 data, and returns its Ghost URL. */
  async function uploadImage(src: { file?: ChatgptFile; url?: string; base64?: string; filename?: string; purpose?: string }): Promise<string> {
    let data: Buffer;
    let filename: string;
    let contentType: string | undefined;
    const fetchOpts = { maxBytes: cfg.maxUploadBytes, timeoutMs: cfg.timeoutMs, allowPrivate: cfg.allowPrivateImageUrls };
    if (src.file) {
      ({ data, filename, contentType } = await fetchImage(src.file.download_url, { ...fetchOpts, mimeType: src.file.mime_type, fileName: src.file.file_name }));
    } else if (src.url) {
      ({ data, filename, contentType } = await fetchImage(src.url, fetchOpts));
    } else if (src.base64) {
      if (!src.filename) throw new Error('filename is required with base64');
      data = Buffer.from(src.base64, 'base64');
      if (data.length > cfg.maxUploadBytes) throw new Error(`Image is larger than the ${cfg.maxUploadBytes} byte limit`);
      filename = src.filename;
      contentType = mimeFromFilename(filename);
    } else {
      throw new Error('Provide file, url or base64');
    }
    if (!data.length) throw new Error('Image is empty');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType ?? 'application/octet-stream' }), filename);
    form.append('purpose', src.purpose ?? 'image');
    const res = await ghost.request('POST', '/images/upload/', { form });
    return first(res, 'images').url;
  }

  // ---- site ---------------------------------------------------------------

  server.registerTool(
    'get_ghost_site',
    {
      title: 'Get Ghost site info',
      description: 'Returns the blog title, description, URL and Ghost version, plus what this MCP server is allowed to do.',
      annotations: READ,
    },
    run(async () => {
      const res = await ghost.get('/site/', undefined, false);
      return {
        ...(res?.site ?? {}),
        mcp: {
          api_version: cfg.apiVersion,
          read_only: cfg.readOnly,
          delete_enabled: cfg.enableDelete && !cfg.readOnly,
          members_enabled: cfg.enableMembers,
        },
      };
    }),
  );

  // ---- posts & pages ------------------------------------------------------

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

  for (const kind of ['post', 'page'] as const) {
    const plural = `${kind}s`;
    const base = `/${plural}/`;
    const Kind = kind === 'post' ? 'Post' : 'Page';

    const listShape = {
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
        inputSchema: listShape,
        annotations: READ,
      },
      run<z.infer<z.ZodObject<typeof listShape>>>(async (a) => {
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

    const getShape = {
      id: z.string().optional().describe(`${Kind} id`),
      slug: z.string().optional().describe(`${Kind} slug (alternative to id)`),
      include_lexical: z.boolean().default(false).describe('Also return the raw Lexical JSON'),
    };
    server.registerTool(
      `get_ghost_${kind}`,
      {
        title: `Get a Ghost ${kind}`,
        description: `Fetches one ${kind} by id or slug, including its HTML body.`,
        inputSchema: getShape,
        annotations: READ,
      },
      run<z.infer<z.ZodObject<typeof getShape>>>(async (a) => {
        if (!a.id && !a.slug) throw new Error('Provide id or slug');
        const path = a.id ? `${base}${encodeURIComponent(a.id)}/` : `${base}slug/${encodeURIComponent(a.slug!)}/`;
        const res = await ghost.get(path, { include: 'tags,authors', formats: 'html' });
        return summarizeContent(first(res, plural), { html: true, lexical: a.include_lexical });
      }),
    );

    if (cfg.readOnly) continue;

    const createShape = { title: z.string().min(1), ...contentShape };
    server.registerTool(
      `create_ghost_${kind}`,
      {
        title: `Create a Ghost ${kind}`,
        description: `Creates a ${kind}. Defaults to a draft. Does not send any newsletter email.`,
        inputSchema: createShape,
        annotations: WRITE,
        ...fileParams('feature_image_file'),
      },
      run<z.infer<z.ZodObject<typeof createShape>>>(async ({ feature_image_file, ...a }) => {
        if (feature_image_file) (a as Json).feature_image = await uploadImage({ file: feature_image_file });
        const body = buildBody(a);
        const res = await ghost.post(base, { [plural]: [body] }, { source: body.html !== undefined ? 'html' : undefined });
        return summarizeContent(first(res, plural));
      }),
    );

    const updateShape = {
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
        inputSchema: updateShape,
        annotations: WRITE,
        ...fileParams('feature_image_file'),
      },
      run<z.infer<z.ZodObject<typeof updateShape>>>(async ({ feature_image_file, ...a }) => {
        const { id, updated_at, ...fields } = a;
        if (feature_image_file) (fields as Json).feature_image = await uploadImage({ file: feature_image_file });
        const body = buildBody(fields);
        if (!Object.keys(body).length) throw new Error('Nothing to update: provide at least one field');
        const path = `${base}${encodeURIComponent(id)}/`;
        const stamp = updated_at ?? first(await ghost.get(path, { fields: 'updated_at' }), plural).updated_at;
        const res = await ghost.put(path, { [plural]: [{ ...body, updated_at: stamp }] }, { source: body.html !== undefined ? 'html' : undefined });
        return summarizeContent(first(res, plural));
      }),
    );

    if (cfg.enableDelete) {
      const deleteShape = { id: z.string().describe(`${Kind} id`) };
      server.registerTool(
        `delete_ghost_${kind}`,
        {
          title: `Delete a Ghost ${kind}`,
          description: `Permanently deletes a ${kind}. Cannot be undone.`,
          inputSchema: deleteShape,
          annotations: DESTRUCTIVE,
        },
        run<z.infer<z.ZodObject<typeof deleteShape>>>(async (a) => {
          await ghost.delete(`${base}${encodeURIComponent(a.id)}/`);
          return { deleted: true, id: a.id };
        }),
      );
    }
  }

  // ---- tags ---------------------------------------------------------------

  const listTagsShape = { limit: limitField, page: pageField, filter: filterField, order: orderField };
  server.registerTool(
    'list_ghost_tags',
    {
      title: 'List Ghost tags',
      description: 'Lists tags with their post counts.',
      inputSchema: listTagsShape,
      annotations: READ,
    },
    run<z.infer<z.ZodObject<typeof listTagsShape>>>(async (a) => {
      const res = await ghost.get('/tags/', { ...a, include: 'count.posts' });
      return paginated('tags', res, summarizeTag);
    }),
  );

  const getTagShape = { id: z.string().optional(), slug: z.string().optional() };
  server.registerTool(
    'get_ghost_tag',
    {
      title: 'Get a Ghost tag',
      description: 'Fetches one tag by id or slug.',
      inputSchema: getTagShape,
      annotations: READ,
    },
    run<z.infer<z.ZodObject<typeof getTagShape>>>(async (a) => {
      if (!a.id && !a.slug) throw new Error('Provide id or slug');
      const path = a.id ? `/tags/${encodeURIComponent(a.id)}/` : `/tags/slug/${encodeURIComponent(a.slug!)}/`;
      return summarizeTag(first(await ghost.get(path, { include: 'count.posts' }), 'tags'));
    }),
  );

  if (!cfg.readOnly) {
    const tagFields = {
      slug: z.string().optional(),
      description: z.string().max(500).optional(),
      feature_image: z.string().url().optional(),
      visibility: z.enum(['public', 'internal']).optional(),
      meta_title: z.string().max(300).optional(),
      meta_description: z.string().max(500).optional(),
      accent_color: z.string().optional().describe('Hex color without #, e.g. "15171a"'),
    };
    const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

    const createTagShape = { name: z.string().min(1), ...tagFields };
    server.registerTool(
      'create_ghost_tag',
      { title: 'Create a Ghost tag', description: 'Creates a tag.', inputSchema: createTagShape, annotations: WRITE },
      run<z.infer<z.ZodObject<typeof createTagShape>>>(async (a) =>
        summarizeTag(first(await ghost.post('/tags/', { tags: [clean(a)] }), 'tags')),
      ),
    );

    const updateTagShape = { id: z.string(), name: z.string().min(1).optional(), ...tagFields };
    server.registerTool(
      'update_ghost_tag',
      { title: 'Update a Ghost tag', description: 'Updates the given fields of a tag.', inputSchema: updateTagShape, annotations: WRITE },
      run<z.infer<z.ZodObject<typeof updateTagShape>>>(async (a) => {
        const { id, ...fields } = a;
        const body = clean(fields);
        if (!Object.keys(body).length) throw new Error('Nothing to update: provide at least one field');
        return summarizeTag(first(await ghost.put(`/tags/${encodeURIComponent(id)}/`, { tags: [body] }), 'tags'));
      }),
    );

    if (cfg.enableDelete) {
      const deleteTagShape = { id: z.string() };
      server.registerTool(
        'delete_ghost_tag',
        { title: 'Delete a Ghost tag', description: 'Permanently deletes a tag.', inputSchema: deleteTagShape, annotations: DESTRUCTIVE },
        run<z.infer<z.ZodObject<typeof deleteTagShape>>>(async (a) => {
          await ghost.delete(`/tags/${encodeURIComponent(a.id)}/`);
          return { deleted: true, id: a.id };
        }),
      );
    }
  }

  // ---- read-only site structure ------------------------------------------

  const simpleList = { limit: limitField, page: pageField };
  server.registerTool(
    'list_ghost_tiers',
    { title: 'List Ghost tiers', description: 'Lists membership tiers.', inputSchema: simpleList, annotations: READ },
    run<z.infer<z.ZodObject<typeof simpleList>>>(async (a) => {
      const res = await ghost.get('/tiers/', a);
      return paginated('tiers', res, (t) => ({ id: t.id, name: t.name, slug: t.slug, type: t.type, active: t.active, visibility: t.visibility, monthly_price: t.monthly_price, yearly_price: t.yearly_price, currency: t.currency }));
    }),
  );
  server.registerTool(
    'list_ghost_newsletters',
    { title: 'List Ghost newsletters', description: 'Lists newsletters.', inputSchema: simpleList, annotations: READ },
    run<z.infer<z.ZodObject<typeof simpleList>>>(async (a) => {
      const res = await ghost.get('/newsletters/', a);
      return paginated('newsletters', res, (n) => ({ id: n.id, name: n.name, slug: n.slug, description: n.description, status: n.status, visibility: n.visibility }));
    }),
  );
  server.registerTool(
    'list_ghost_users',
    { title: 'List Ghost staff users', description: 'Lists staff users (authors) and their roles.', inputSchema: simpleList, annotations: READ },
    run<z.infer<z.ZodObject<typeof simpleList>>>(async (a) => {
      const res = await ghost.get('/users/', { ...a, include: 'roles' });
      return paginated('users', res, (u) => ({ id: u.id, name: u.name, slug: u.slug, email: u.email, status: u.status, roles: names(u.roles) }));
    }),
  );

  // ---- members (opt-in: personal data) ------------------------------------

  if (cfg.enableMembers) {
    const listMembersShape = {
      limit: limitField,
      page: pageField,
      filter: z.string().optional().describe('NQL filter, e.g. "status:paid" or "label:vip"'),
      search: z.string().optional().describe('Match on name or email'),
      order: orderField,
    };
    server.registerTool(
      'list_ghost_members',
      { title: 'List Ghost members', description: 'Lists members (contains personal data).', inputSchema: listMembersShape, annotations: READ },
      run<z.infer<z.ZodObject<typeof listMembersShape>>>(async (a) => {
        const res = await ghost.get('/members/', { ...a, include: 'newsletters,labels' });
        return paginated('members', res, summarizeMember);
      }),
    );

    const getMemberShape = { id: z.string() };
    server.registerTool(
      'get_ghost_member',
      { title: 'Get a Ghost member', description: 'Fetches one member by id.', inputSchema: getMemberShape, annotations: READ },
      run<z.infer<z.ZodObject<typeof getMemberShape>>>(async (a) =>
        summarizeMember(first(await ghost.get(`/members/${encodeURIComponent(a.id)}/`, { include: 'newsletters,labels,tiers' }), 'members')),
      ),
    );

    if (!cfg.readOnly) {
      const createMemberShape = {
        email: z.string().email(),
        name: z.string().optional(),
        note: z.string().max(2000).optional(),
        labels: z.array(z.string()).optional().describe('Label names; missing labels are created'),
      };
      server.registerTool(
        'create_ghost_member',
        { title: 'Create a Ghost member', description: 'Adds a member. Sends no email.', inputSchema: createMemberShape, annotations: WRITE },
        run<z.infer<z.ZodObject<typeof createMemberShape>>>(async (a) => {
          const { labels, ...rest } = a;
          const body: Json = { ...rest };
          if (labels) body.labels = labels.map((name) => ({ name }));
          return summarizeMember(first(await ghost.post('/members/', { members: [body] }), 'members'));
        }),
      );

      const updateMemberShape = {
        id: z.string(),
        name: z.string().optional(),
        note: z.string().max(2000).optional(),
        labels: z.array(z.string()).optional().describe('Replaces the existing labels'),
      };
      server.registerTool(
        'update_ghost_member',
        { title: 'Update a Ghost member', description: 'Updates a member\'s name, note or labels.', inputSchema: updateMemberShape, annotations: WRITE },
        run<z.infer<z.ZodObject<typeof updateMemberShape>>>(async (a) => {
          const { id, labels, ...rest } = a;
          const body: Json = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
          if (labels) body.labels = labels.map((name) => ({ name }));
          if (!Object.keys(body).length) throw new Error('Nothing to update: provide at least one field');
          return summarizeMember(first(await ghost.put(`/members/${encodeURIComponent(id)}/`, { members: [body] }), 'members'));
        }),
      );
    }
  }

  // ---- images -------------------------------------------------------------

  if (!cfg.readOnly) {
    const uploadShape = {
      file: chatgptFile.optional().describe('Image attached in ChatGPT, including images ChatGPT generated'),
      url: z.string().url().optional().describe('Public http(s) image URL to download and upload to Ghost'),
      base64: z.string().optional().describe('Base64-encoded image bytes (small images only)'),
      filename: z.string().optional().describe('File name with extension; required with base64'),
      purpose: z.enum(['image', 'profile_image', 'icon']).default('image'),
    };
    server.registerTool(
      'upload_ghost_image',
      {
        title: 'Upload an image to Ghost',
        description:
          'Uploads an image to the Ghost media library and returns its URL, for use as feature_image or inside html. Accepts an attached/generated ChatGPT image (file), a public URL, or base64.',
        inputSchema: uploadShape,
        annotations: WRITE,
        ...fileParams('file'),
      },
      run<z.infer<z.ZodObject<typeof uploadShape>>>(async (a) => ({ url: await uploadImage(a) })),
    );
  }
}
