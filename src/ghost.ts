import { createHmac } from 'node:crypto';
import type { Config } from './config.js';

export type Json = Record<string, any>;

export class GhostError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Admin API tokens are HS256 JWTs: header.kid = key id, aud = /admin/,
 * exp at most 5 minutes after iat, signed with the hex-decoded secret.
 * https://docs.ghost.org/admin-api#token-authentication
 */
export function signToken(keyId: string, secret: Buffer, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT', kid: keyId });
  const body = enc({ iat, exp: iat + 240, aud: '/admin/' });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  form?: FormData;
  /** The /site/ endpoint is public; everything else needs a token. */
  auth?: boolean;
}

export class GhostClient {
  constructor(private readonly cfg: Config) {}

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Json | null> {
    const url = new URL(`${this.cfg.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Version': this.cfg.apiVersion,
      'User-Agent': 'ghost-mcp/1.0',
    };
    if (opts.auth !== false) {
      headers.Authorization = `Ghost ${signToken(this.cfg.keyId, this.cfg.keySecret)}`;
    }
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        // Redirects would drop the POST/PUT body or the auth header; surface them instead.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const reason = err.name === 'TimeoutError' ? 'timed out' : (err.cause?.code ?? err.message);
      throw new GhostError(`Could not reach Ghost at ${this.cfg.apiBase} (${reason})`);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? 'unknown';
      throw new GhostError(
        `Ghost answered ${res.status} redirect to ${loc}. GHOST_URL must be the exact public URL ` +
          `Ghost is configured with (scheme, host and subdirectory), not an internal address.`,
        res.status,
      );
    }

    const text = await res.text();
    let data: Json | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as Json;
      } catch {
        if (res.ok) throw new GhostError(`Ghost returned a non-JSON response (HTTP ${res.status})`, res.status);
      }
    }

    if (!res.ok) {
      const errs = Array.isArray(data?.errors) ? (data!.errors as Json[]) : [];
      const detail = errs
        .map((e) => [e.message, e.context].filter(Boolean).join(' - '))
        .filter(Boolean)
        .join('; ');
      throw new GhostError(`Ghost API ${method} ${path} failed: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`, res.status);
    }
    return data;
  }

  get(path: string, query?: RequestOptions['query'], auth?: boolean) {
    return this.request('GET', path, { query, auth });
  }
  post(path: string, body: unknown, query?: RequestOptions['query']) {
    return this.request('POST', path, { body, query });
  }
  put(path: string, body: unknown, query?: RequestOptions['query']) {
    return this.request('PUT', path, { body, query });
  }
  delete(path: string) {
    return this.request('DELETE', path);
  }
}
