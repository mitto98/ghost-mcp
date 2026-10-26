export interface Config {
  /** Public Ghost URL (as configured in Ghost), without trailing slash. */
  ghostUrl: string;
  /** Base URL of the Admin API, e.g. https://blog.example/ghost/api/admin */
  apiBase: string;
  keyId: string;
  keySecret: Buffer;
  /** Sent as the Accept-Version header, e.g. "v5.0". */
  apiVersion: string;
  mcpSecret: string;
  host: string;
  port: number;
  readOnly: boolean;
  enableDelete: boolean;
  enableMembers: boolean;
  timeoutMs: number;
  maxUploadBytes: number;
  /** Allow image downloads from private/loopback addresses (off by default, SSRF guard). */
  allowPrivateImageUrls: boolean;
}

export class ConfigError extends Error {}

const KEY_RE = /^([0-9a-f]{24}):([0-9a-f]{64})$/i;

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function int(v: string | undefined, def: number, name: string, errors: string[]): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer`);
    return def;
  }
  return n;
}

/** Strip trailing slashes and an accidental /ghost or /ghost/api/admin suffix. */
export function normalizeGhostUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('must be http(s)');
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/ghost(\/api\/admin)?$/i, '');
  return `${u.origin}${path}`;
}

/**
 * Reads and validates configuration. Error messages never include secret values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];

  let ghostUrl = '';
  const rawUrl = env.GHOST_URL;
  if (!rawUrl) errors.push('GHOST_URL is required (the public URL Ghost is configured with)');
  else {
    try {
      ghostUrl = normalizeGhostUrl(rawUrl);
    } catch {
      errors.push('GHOST_URL is not a valid http(s) URL');
    }
  }

  // Optional: Admin API served from a different domain than the site.
  let adminUrl = ghostUrl;
  if (env.GHOST_ADMIN_URL) {
    try {
      adminUrl = normalizeGhostUrl(env.GHOST_ADMIN_URL);
    } catch {
      errors.push('GHOST_ADMIN_URL is not a valid http(s) URL');
    }
  }

  let keyId = '';
  let keySecret = Buffer.alloc(0);
  const rawKey = env.GHOST_ADMIN_KEY?.trim();
  if (!rawKey) errors.push('GHOST_ADMIN_KEY is required (<24 hex id>:<64 hex secret>)');
  else {
    const m = KEY_RE.exec(rawKey);
    if (!m) errors.push('GHOST_ADMIN_KEY has the wrong format, expected <24 hex>:<64 hex>');
    else {
      keyId = m[1]!;
      keySecret = Buffer.from(m[2]!, 'hex');
    }
  }

  const mcpSecret = env.MCP_SECRET?.trim() ?? '';
  if (mcpSecret.length < 16) {
    errors.push('MCP_SECRET is required and must be at least 16 characters (use: openssl rand -hex 32)');
  } else if (!/^[A-Za-z0-9._~-]+$/.test(mcpSecret)) {
    errors.push('MCP_SECRET may only contain letters, digits and . _ ~ - (it is used in a URL path)');
  }

  const apiVersion = (env.GHOST_API_VERSION?.trim() || 'v5.0');
  if (!/^v\d+(\.\d+)?$/.test(apiVersion)) errors.push('GHOST_API_VERSION must look like v5.0');

  const port = int(env.PORT, 3000, 'PORT', errors);
  const timeoutMs = int(env.GHOST_TIMEOUT_MS, 30_000, 'GHOST_TIMEOUT_MS', errors);
  const maxUploadBytes = int(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 'MAX_UPLOAD_BYTES', errors);

  if (errors.length) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    ghostUrl,
    apiBase: `${adminUrl}/ghost/api/admin`,
    keyId,
    keySecret,
    apiVersion,
    mcpSecret,
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    readOnly: bool(env.READ_ONLY, false),
    enableDelete: bool(env.ENABLE_DELETE, false),
    enableMembers: bool(env.ENABLE_MEMBERS, false),
    timeoutMs,
    maxUploadBytes,
    allowPrivateImageUrls: bool(env.ALLOW_PRIVATE_IMAGE_URLS, false),
  };
}
