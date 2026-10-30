import { fetchImage, mimeFromFilename } from '../../images.js';
import type { ToolContext } from '../context.js';
import { first } from './helpers.js';
import type { ChatgptFile } from './params.js';

export interface ImageSource {
  file?: ChatgptFile;
  url?: string;
  base64?: string;
  filename?: string;
  purpose?: string;
}

/** Uploads an image to Ghost from a ChatGPT file, a URL or base64 data, and returns its Ghost URL. */
export async function uploadImage({ ghost, cfg }: ToolContext, src: ImageSource): Promise<string> {
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
