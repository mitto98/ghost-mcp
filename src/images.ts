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
async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) image URLs are allowed');
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

export async function fetchImage(rawUrl: string, maxBytes: number, timeoutMs: number): Promise<FetchedImage> {
  const u = await assertPublicHttpUrl(rawUrl);
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`URL did not return an image (content-type: ${contentType || 'none'})`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`Image is larger than the ${maxBytes} byte limit`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Image is larger than the ${maxBytes} byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  let filename = path.basename(u.pathname) || 'image';
  if (!path.extname(filename)) filename += EXT_BY_MIME[contentType] ?? '';
  return { data: Buffer.concat(chunks), filename, contentType };
}
