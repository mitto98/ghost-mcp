import { z } from 'zod';
import type { ToolModule } from './context.js';
import { run } from './shared/helpers.js';
import { chatgptFile, fileParams, WRITE } from './shared/params.js';
import { uploadImage } from './shared/upload.js';

const shape = {
  file: chatgptFile.optional().describe('Image attached in ChatGPT, including images ChatGPT generated'),
  url: z.string().url().optional().describe('Public http(s) image URL to download and upload to Ghost'),
  base64: z.string().optional().describe('Base64-encoded image bytes (small images only)'),
  filename: z.string().optional().describe('File name with extension; required with base64'),
  purpose: z.enum(['image', 'profile_image', 'icon']).default('image'),
};

const uploadGhostImage: ToolModule = (ctx) => {
  if (ctx.cfg.readOnly) return;
  ctx.server.registerTool(
    'upload_ghost_image',
    {
      title: 'Upload an image to Ghost',
      description:
        'Uploads an image to the Ghost media library and returns its URL, for use as feature_image or inside html. Accepts an attached/generated ChatGPT image (file), a public URL, or base64.',
      inputSchema: shape,
      annotations: WRITE,
      ...fileParams('file'),
    },
    run<z.infer<z.ZodObject<typeof shape>>>(async (a) => ({ url: await uploadImage(ctx, a) })),
  );
};

export default uploadGhostImage;
