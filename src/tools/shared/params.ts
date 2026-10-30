import { z } from 'zod';

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export const limitField = z.number().int().min(1).max(100).default(15).describe('Page size (1-100)');
export const pageField = z.number().int().min(1).default(1).describe('Page number, starting at 1');
export const filterField = z.string().optional().describe('Ghost NQL filter, e.g. "tag:news+status:published" or "featured:true"');
export const orderField = z.string().optional().describe('Sort order, e.g. "published_at desc"');

/** {limit, page}, shared by the simple list tools. */
export const simpleListShape = { limit: limitField, page: pageField };

export const chatgptFile = z
  .object({
    download_url: z.string().url(),
    file_id: z.string().optional(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .describe('A file attached in ChatGPT (including images it generated); ChatGPT fills this in automatically.');
export type ChatgptFile = z.infer<typeof chatgptFile>;

/** Tells ChatGPT these parameters take attached files, which it then sends as {download_url, file_id}. */
export const fileParams = (...names: string[]) => ({ _meta: { 'openai/fileParams': names } });
