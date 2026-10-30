import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { GhostClient } from './ghost.js';
import { registerTools } from './tools/index.js';

const MAX_BODY_BYTES = 1024 * 1024;

export function createMcpServer(cfg: Config, ghost: GhostClient): McpServer {
  const server = new McpServer({ name: 'ghost-mcp', version: '1.0.0' });
  registerTools(server, ghost, cfg);
  return server;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Parse error'), { status: 400, rpc: -32700 });
  }
}

/** Extracts the secret from /mcp/<secret> or an "Authorization: Bearer <secret>" header. */
function extractSecret(req: http.IncomingMessage, segments: string[]): string | undefined {
  if (segments[1]) {
    try {
      return decodeURIComponent(segments[1]);
    } catch {
      return undefined;
    }
  }
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

export function createHttpServer(cfg: Config, ghost = new GhostClient(cfg), log: (line: Record<string, unknown>) => void = () => {}) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    let rpcMethod: string | undefined;
    res.on('finish', () => {
      // The URL path carries the secret, so only a fixed route label is logged.
      log({ method: req.method, route: route(req.url), status: res.statusCode, ms: Date.now() - started, rpc: rpcMethod });
    });

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (segments.length === 1 && segments[0] === 'healthz') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (segments[0] !== 'mcp' || segments.length > 2) {
        return sendJson(res, 404, { error: 'not found' });
      }
      if (!secretMatches(extractSecret(req, segments), cfg.mcpSecret)) {
        return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream (GET) and no sessions to terminate (DELETE).
        return sendJson(res, 405, rpcError(-32000, 'Method not allowed: this server is stateless, use POST'), { Allow: 'POST' });
      }

      const body = await readBody(req);
      rpcMethod = describe(body);

      // A fresh server + transport per request: no session state is kept anywhere.
      const server = createMcpServer(cfg, ghost);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const err = e as Error & { status?: number; rpc?: number };
      if (res.headersSent) return void res.end();
      sendJson(res, err.status ?? 500, rpcError(err.rpc ?? -32603, err.status ? err.message : 'Internal server error'));
    }
  });
}

function route(url: string | undefined): string {
  const first = (url ?? '').split('?')[0]!.split('/').filter(Boolean)[0];
  return first === 'mcp' || first === 'healthz' ? `/${first}` : '(other)';
}

function describe(body: unknown): string | undefined {
  const one = Array.isArray(body) ? body[0] : body;
  if (!one || typeof one !== 'object') return undefined;
  const { method, params } = one as { method?: string; params?: { name?: string } };
  return method === 'tools/call' && params?.name ? `tools/call:${params.name}` : method;
}
