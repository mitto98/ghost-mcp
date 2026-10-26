import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, normalizeGhostUrl } from '../dist/config.js';
import { signToken } from '../dist/ghost.js';
import { createHttpServer } from '../dist/server.js';

const KEY_ID = randomBytes(12).toString('hex');
const KEY_SECRET = randomBytes(32).toString('hex');
const MCP_SECRET = randomBytes(16).toString('hex');

/** Mock Ghost Admin API that validates tokens the way Ghost does. */
function startMockGhost() {
  const calls = [];
  let postUpdatedAt = '2026-01-01T00:00:00.000Z';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const p = url.pathname.replace('/ghost/api/admin', '');
    if (p === '/site/') return json(200, { site: { title: 'Mock Blog', description: 'd', url: 'https://blog.test', version: '5.100' } });

    const m = /^Ghost (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return json(401, { errors: [{ message: 'Authorization header missing' }] });
    const [h, b, s] = m[1].split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const payload = JSON.parse(Buffer.from(b, 'base64url'));
    const sig = createHmac('sha256', Buffer.from(KEY_SECRET, 'hex')).update(`${h}.${b}`).digest('base64url');
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'HS256' || header.kid !== KEY_ID || sig !== s || payload.aud !== '/admin/' || payload.exp - payload.iat > 300 || payload.exp < now) {
      return json(403, { errors: [{ message: 'Invalid token', type: 'NoPermissionError' }] });
    }
    if (!req.headers['accept-version']) return json(400, { errors: [{ message: 'no accept-version' }] });

    const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body, ct: req.headers['content-type'] });

    const post = { id: 'p1', title: 'Hello', slug: 'hello', status: 'published', url: 'https://blog.test/hello/', updated_at: postUpdatedAt, html: '<p>hi</p>', tags: [{ name: 'news' }], authors: [{ name: 'Ann' }] };
    if (p === '/posts/' && req.method === 'GET') return json(200, { posts: [post], meta: { pagination: { page: 1, limit: 15, pages: 1, total: 1 } } });
    if (p === '/posts/p1/' && req.method === 'GET') return json(200, { posts: [post] });
    if (p === '/posts/slug/hello/' && req.method === 'GET') return json(200, { posts: [post] });
    if (p === '/posts/' && req.method === 'POST') return json(201, { posts: [{ ...post, ...body.posts[0], id: 'p2' }] });
    if (p === '/posts/p1/' && req.method === 'PUT') {
      if (body.posts[0].updated_at !== postUpdatedAt) return json(409, { errors: [{ message: 'Saving failed', context: 'stale' }] });
      postUpdatedAt = '2026-02-02T00:00:00.000Z';
      return json(200, { posts: [{ ...post, ...body.posts[0], updated_at: postUpdatedAt }] });
    }
    if (p === '/posts/p1/' && req.method === 'DELETE') return json(204);
    if (p === '/tags/') return json(200, { tags: [{ id: 't1', name: 'news', slug: 'news', count: { posts: 3 } }], meta: {} });
    if (p === '/images/upload/') return json(201, { images: [{ url: 'https://blog.test/content/images/a.png' }] });
    return json(404, { errors: [{ message: 'Resource not found' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const baseEnv = (ghostPort, extra = {}) => ({
  GHOST_URL: `http://127.0.0.1:${ghostPort}`,
  GHOST_ADMIN_KEY: `${KEY_ID}:${KEY_SECRET}`,
  MCP_SECRET,
  ...extra,
});

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const rpc = (port, path, method, params, id = 1) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
const callTool = async (port, name, args = {}) => {
  const res = await rpc(port, `/mcp/${MCP_SECRET}`, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200);
  return (await res.json()).result;
};

describe('config', () => {
  it('normalizes the Ghost URL', () => {
    assert.equal(normalizeGhostUrl('https://a.test/'), 'https://a.test');
    assert.equal(normalizeGhostUrl('https://a.test/blog/ghost/'), 'https://a.test/blog');
    assert.equal(normalizeGhostUrl('https://a.test/ghost/api/admin/'), 'https://a.test');
  });
  it('rejects bad config without echoing secrets', () => {
    assert.throws(() => loadConfig({ GHOST_URL: 'nope', GHOST_ADMIN_KEY: 'abc:def', MCP_SECRET: 'short' }), (e) => {
      assert.match(e.message, /GHOST_URL/);
      assert.match(e.message, /GHOST_ADMIN_KEY/);
      assert.match(e.message, /MCP_SECRET/);
      assert.ok(!e.message.includes('abc:def'));
      return true;
    });
  });
  it('signs tokens Ghost accepts', () => {
    const [h, b] = signToken(KEY_ID, Buffer.from(KEY_SECRET, 'hex')).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT', kid: KEY_ID });
    assert.equal(JSON.parse(Buffer.from(b, 'base64url')).aud, '/admin/');
  });
});

describe('server (default: delete disabled)', () => {
  let ghost, mcp, port, logs;
  before(async () => {
    ghost = await startMockGhost();
    logs = [];
    mcp = createHttpServer(loadConfig(baseEnv(ghost.port)), undefined, (l) => logs.push(l));
    port = await listen(mcp);
  });
  after(() => { mcp.close(); ghost.server.close(); });

  it('healthz is open', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
  });

  it('rejects missing or wrong secret with 401', async () => {
    assert.equal((await rpc(port, '/mcp', 'tools/list', {})).status, 401);
    assert.equal((await rpc(port, '/mcp/', 'tools/list', {})).status, 401);
    assert.equal((await rpc(port, '/mcp/wrong', 'tools/list', {})).status, 401);
  });

  it('accepts the secret as a Bearer token too', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { ...HEADERS, Authorization: `Bearer ${MCP_SECRET}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(res.status, 200);
  });

  it('needs no session id and returns no mcp-session-id', async () => {
    const res = await rpc(port, `/mcp/${MCP_SECRET}`, 'tools/list', {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('mcp-session-id'), null);
    // repeated, with an unknown session id header, still works
    const again = await fetch(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`, {
      method: 'POST', headers: { ...HEADERS, 'mcp-session-id': 'stale' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(again.status, 200);
  });

  it('lists tools without delete_*', async () => {
    const tools = (await (await rpc(port, `/mcp/${MCP_SECRET}`, 'tools/list', {})).json()).result.tools.map((t) => t.name);
    assert.ok(tools.includes('get_ghost_site') && tools.includes('list_ghost_posts') && tools.includes('create_ghost_post'));
    assert.deepEqual(tools.filter((n) => n.startsWith('delete_')), []);
    assert.ok(!tools.some((n) => n.includes('member')), 'members are opt-in');
  });

  it('get_ghost_site returns title and version without auth', async () => {
    const r = await callTool(port, 'get_ghost_site');
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.title, 'Mock Blog');
    assert.equal(data.version, '5.100');
    assert.equal(data.mcp.delete_enabled, false);
  });

  it('list_ghost_posts passes limit and returns a compact summary', async () => {
    const r = await callTool(port, 'list_ghost_posts', { limit: 3 });
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.posts[0].title, 'Hello');
    assert.deepEqual(data.posts[0].tags, ['news']);
    assert.equal(data.posts[0].html, undefined);
    assert.equal(ghost.calls.at(-1).query.limit, '3');
  });

  it('create with html uses source=html and defaults nothing destructive', async () => {
    const r = await callTool(port, 'create_ghost_post', { title: 'T', html: '<p>x</p>', tags: ['a', 'b'] });
    assert.ok(!r.isError);
    const c = ghost.calls.at(-1);
    assert.equal(c.method, 'POST');
    assert.equal(c.query.source, 'html');
    assert.deepEqual(c.body.posts[0].tags, [{ name: 'a' }, { name: 'b' }]);
  });

  it('update fetches updated_at itself, and a stale one is rejected', async () => {
    const ok = await callTool(port, 'update_ghost_post', { id: 'p1', title: 'New' });
    assert.ok(!ok.isError, ok.content[0].text);
    const stale = await callTool(port, 'update_ghost_post', { id: 'p1', title: 'Again', updated_at: '2020-01-01T00:00:00.000Z' });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /409/);
  });

  it('upload_ghost_image works from base64 and refuses private URLs', async () => {
    const r = await callTool(port, 'upload_ghost_image', { base64: Buffer.from('png').toString('base64'), filename: 'a.png' });
    assert.equal(JSON.parse(r.content[0].text).url, 'https://blog.test/content/images/a.png');
    assert.match(ghost.calls.at(-1).ct, /multipart\/form-data/);
    const bad = await callTool(port, 'upload_ghost_image', { url: 'http://127.0.0.1:1/x.png' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /private/);
  });

  it('GET is 405 and logs never contain the secret', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`);
    assert.equal(res.status, 405);
    assert.ok(!JSON.stringify(logs).includes(MCP_SECRET));
  });

  it('works with the official MCP client (initialize handshake, no sessions)', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    const { tools } = await client.listTools();
    assert.ok(tools.length > 5);
    const r = await client.callTool({ name: 'list_ghost_tags', arguments: {} });
    assert.equal(JSON.parse(r.content[0].text).tags[0].posts, 3);
    await client.close();
  });
});

describe('server (flags)', () => {
  it('ENABLE_DELETE exposes delete tools and they work; READ_ONLY hides writes', async () => {
    const ghost = await startMockGhost();
    const del = createHttpServer(loadConfig(baseEnv(ghost.port, { ENABLE_DELETE: 'true', ENABLE_MEMBERS: 'true' })));
    const ro = createHttpServer(loadConfig(baseEnv(ghost.port, { ENABLE_DELETE: 'true', READ_ONLY: 'true' })));
    const [pd, pr] = [await listen(del), await listen(ro)];
    const names = async (p) => (await (await rpc(p, `/mcp/${MCP_SECRET}`, 'tools/list', {})).json()).result.tools.map((t) => t.name);
    const withDelete = await names(pd);
    assert.ok(withDelete.includes('delete_ghost_post') && withDelete.includes('list_ghost_members'));
    const r = await callTool(pd, 'delete_ghost_post', { id: 'p1' });
    assert.deepEqual(JSON.parse(r.content[0].text), { deleted: true, id: 'p1' });
    const readOnly = await names(pr);
    assert.ok(!readOnly.some((n) => /^(create|update|delete|upload)_/.test(n)), readOnly.join());
    del.close(); ro.close(); ghost.server.close();
  });

  it('wrong admin key surfaces a clear tool error', async () => {
    const ghost = await startMockGhost();
    const srv = createHttpServer(loadConfig(baseEnv(ghost.port, { GHOST_ADMIN_KEY: `${KEY_ID}:${'0'.repeat(64)}` })));
    const p = await listen(srv);
    const r = await callTool(p, 'list_ghost_posts');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /403/);
    srv.close(); ghost.server.close();
  });

  it('a redirecting Ghost URL gives an actionable error', async () => {
    const redirector = http.createServer((req, res) => { res.writeHead(301, { Location: 'https://public.test/ghost/api/admin/posts/' }); res.end(); });
    const rp = await listen(redirector);
    const srv = createHttpServer(loadConfig(baseEnv(rp)));
    const p = await listen(srv);
    const r = await callTool(p, 'list_ghost_posts');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /GHOST_URL must be the exact public URL/);
    srv.close(); redirector.close();
  });
});

describe('ChatGPT file params', () => {
  // Smallest valid PNG header + padding; served as octet-stream like ChatGPT's download URLs.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  let ghost, images, mcp, port;
  before(async () => {
    ghost = await startMockGhost();
    images = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(png); });
    const ip = await listen(images);
    mcp = createHttpServer(loadConfig(baseEnv(ghost.port, { ALLOW_PRIVATE_IMAGE_URLS: 'true' })));
    port = await listen(mcp);
    images.fileUrl = `http://127.0.0.1:${ip}/download/abc`;
  });
  after(() => { mcp.close(); images.close(); ghost.server.close(); });

  it('advertises openai/fileParams on the image tools', async () => {
    const tools = (await (await rpc(port, `/mcp/${MCP_SECRET}`, 'tools/list', {})).json()).result.tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(by.upload_ghost_image._meta['openai/fileParams'], ['file']);
    assert.deepEqual(by.create_ghost_post._meta['openai/fileParams'], ['feature_image_file']);
    assert.deepEqual(by.update_ghost_page._meta['openai/fileParams'], ['feature_image_file']);
    assert.ok(by.upload_ghost_image.inputSchema.properties.file.properties.download_url);
  });

  it('uploads an attached image even when the host says octet-stream', async () => {
    const r = await callTool(port, 'upload_ghost_image', { file: { download_url: images.fileUrl, file_id: 'file_1', file_name: 'cover.png' } });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(JSON.parse(r.content[0].text).url, 'https://blog.test/content/images/a.png');
    assert.match(ghost.calls.at(-1).ct, /multipart\/form-data/);
  });

  it('create_ghost_post uploads feature_image_file and sets feature_image', async () => {
    const r = await callTool(port, 'create_ghost_post', {
      title: 'Recensione', html: '<p>x</p>', status: 'draft',
      feature_image_file: { download_url: images.fileUrl, file_id: 'file_2' },
      meta_title: 'SEO', meta_description: 'desc',
    });
    assert.ok(!r.isError, r.content[0].text);
    const c = ghost.calls.at(-1);
    assert.equal(c.path, '/posts/');
    assert.equal(c.body.posts[0].feature_image, 'https://blog.test/content/images/a.png');
    assert.equal(c.body.posts[0].feature_image_file, undefined);
    assert.equal(c.body.posts[0].meta_title, 'SEO');
  });

  it('rejects non-image downloads', async () => {
    const text = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope</html>'); });
    const tp = await listen(text);
    const r = await callTool(port, 'upload_ghost_image', { file: { download_url: `http://127.0.0.1:${tp}/x`, file_id: 'f' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /did not return an image/);
    text.close();
  });

  it('private download URLs stay blocked by default', async () => {
    const strict = createHttpServer(loadConfig(baseEnv(ghost.port)));
    const sp = await listen(strict);
    const r = await callTool(sp, 'upload_ghost_image', { file: { download_url: images.fileUrl, file_id: 'f' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /private/);
    strict.close();
  });
});

