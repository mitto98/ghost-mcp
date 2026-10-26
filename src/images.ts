import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));

export function mimeFromFilename(name: string): string | undefined {
  return MIME_BY_EXT[path.extname(name).toLowerCase()];
}

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return true; // IPv4-mapped: be conservative
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

/** Refuse URLs that point at loopback/private networks (the container can see Ghost, Traefik, ...). */
async function assertPublicHttpUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) image URLs are allowed');
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('Image URL resolves to a private or loopback address, which is not allowed');
  }
  return u;
}

export interface FetchedImage {
  data: Buffer;
  filename: string;
  contentType: string;
}

export interface FetchImageOptions {
  maxBytes: number;
  timeoutMs: number;
  allowPrivate?: boolean;
  /** Hints from the caller (e.g. a ChatGPT file param) for hosts that serve application/octet-stream. */
  mimeType?: string;
  fileName?: string;
}

/** Identifies common image formats from their magic bytes. */
export function sniffImageType(b: Buffer): string | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 12).toString('latin1') === 'ftypavif') return 'image/avif';
  return undefined;
}

export async function fetchImage(rawUrl: string, opts: FetchImageOptions): Promise<FetchedImage> {
  const { maxBytes, timeoutMs } = opts;
  const u = await assertPublicHttpUrl(rawUrl, opts.allowPrivate ?? false);
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`Image is larger than the ${maxBytes} byte limit`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Image is larger than the ${maxBytes} byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);

  // Trust the bytes first: download hosts often answer application/octet-stream.
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const contentType =
    sniffImageType(data) ??
    [headerType, opts.mimeType?.toLowerCase(), opts.fileName ? mimeFromFilename(opts.fileName) : undefined].find((t) => t?.startsWith('image/'));
  if (!contentType) throw new Error(`URL did not return an image (content-type: ${headerType || 'none'})`);

  let filename = opts.fileName ? path.basename(opts.fileName) : path.basename(u.pathname) || 'image';
  if (!path.extname(filename)) filename += EXT_BY_MIME[contentType] ?? '';
  return { data, filename, contentType };
}
