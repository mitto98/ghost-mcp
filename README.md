# ghost-mcp

A **stateless** [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
MCP server for **any Ghost instance**, built on the official `@modelcontextprotocol/sdk` and the
[Ghost Admin API](https://docs.ghost.org/admin-api).

- **No sessions.** Every request gets a fresh server and transport, so restarts, redeploys and
  load balancing never produce `400 No valid session ID provided`. No `mcp-session-id` header is
  ever required or returned.
- **Any Ghost.** Self-hosted or Ghost(Pro): just set `GHOST_URL` and an Admin API key. One container
  talks to one Ghost; run several containers for several blogs.
- **Safe defaults.** Delete tools and member tools are off unless you enable them, and `READ_ONLY=true`
  removes every write tool.
- **Two runtime dependencies** (`@modelcontextprotocol/sdk`, `zod`). JWT signing uses `node:crypto`,
  HTTP uses `node:http`.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `GHOST_URL` | yes | | The **public URL Ghost is configured with**. Never an internal address such as `http://ghost:2368`: Ghost redirects it and the Admin API call fails with 403. A trailing `/ghost` or `/ghost/api/admin` is stripped; subdirectory installs (`https://x.com/blog`) work. |
| `GHOST_ADMIN_KEY` | yes | | Admin API key `<24 hex>:<64 hex>` from *Ghost Admin > Settings > Integrations > Add custom integration*. |
| `MCP_SECRET` | yes | | Shared secret protecting this server, at least 16 chars of `A-Za-z0-9._~-`. Generate with `openssl rand -hex 32`. |
| `GHOST_API_VERSION` | no | `v5.0` | Sent as `Accept-Version` (minimum Ghost API version). Works with Ghost 5 and 6. |
| `GHOST_ADMIN_URL` | no | `GHOST_URL` | Only if the Admin API is on another domain than the site. |
| `ENABLE_DELETE` | no | `false` | Registers `delete_ghost_post`, `delete_ghost_page`, `delete_ghost_tag`. |
| `ENABLE_MEMBERS` | no | `false` | Registers member tools (personal data). |
| `READ_ONLY` | no | `false` | Registers read tools only, overriding the two flags above for writes. |
| `PORT` / `HOST` | no | `3000` / `0.0.0.0` | |
| `GHOST_TIMEOUT_MS` | no | `30000` | Per Ghost request. |
| `MAX_UPLOAD_BYTES` | no | `10485760` | Limit for image uploads. |
| `ALLOW_PRIVATE_IMAGE_URLS` | no | `false` | Allow image downloads from private/loopback addresses. Leave off unless your image host is internal. |

The server refuses to start (exit 1) if anything required is missing or malformed, and the error
never prints secret values. On boot it logs whether Ghost is reachable and whether the Admin key is
accepted, so redirect and key problems are visible in `docker compose logs`.

## Authentication

The MCP endpoint is `POST /mcp/<MCP_SECRET>`. The secret may instead be sent as
`Authorization: Bearer <MCP_SECRET>` to `POST /mcp`. Anything else is `401`. The comparison is
constant-time and the path is never logged. This is meant for clients like the Claude connector that
cannot send custom auth; use HTTPS (Traefik) so the URL is not exposed in transit, and treat the URL
as a password.

`GET /healthz` is unauthenticated and returns `{"status":"ok"}` (used by the Docker healthcheck).

## Tools

| Tool | Notes |
| --- | --- |
| `get_ghost_site` | Title, description, URL, Ghost version, and what this server may do |
| `list_ghost_posts` / `list_ghost_pages` | `limit`, `page`, `status`, NQL `filter`, `order`, `include_content` |
| `get_ghost_post` / `get_ghost_page` | By `id` or `slug`; includes HTML |
| `create_ghost_post` / `create_ghost_page` | `html` (converted to Lexical via `?source=html`), tags, authors, status, scheduling, SEO fields, `feature_image_file`. Defaults to draft |
| `update_ghost_post` / `update_ghost_page` | Partial update; `updated_at` is fetched automatically (or pass one for optimistic locking) |
| `list_ghost_tags`, `get_ghost_tag`, `create_ghost_tag`, `update_ghost_tag` | |
| `list_ghost_tiers`, `list_ghost_newsletters`, `list_ghost_users` | Read-only |
| `upload_ghost_image` | From an attached/generated ChatGPT image (`file`), a public URL (private/loopback addresses refused) or base64 |
| `delete_ghost_post/page/tag` | Only with `ENABLE_DELETE=true` |
| `list/get/create/update_ghost_member` | Only with `ENABLE_MEMBERS=true` |

### Images from ChatGPT

ChatGPT cannot put a generated image's bytes into a normal tool argument. The image tools therefore declare
`_meta["openai/fileParams"]`, so ChatGPT sends attached or generated images as `{download_url, file_id}`;
the server downloads that temporary URL (never logged or echoed back), checks it really is an image
(by its bytes, since these hosts often answer `application/octet-stream`), and uploads it to Ghost.
`create_ghost_post` / `update_ghost_post` (and the page equivalents) take `feature_image_file` directly,
so a draft with its cover image is one call. Other clients can keep using `feature_image` / `url` / `base64`.

Deliberately **not** supported: sending a post as a newsletter email. Publish from here, send from Ghost Admin.
Setting `html` on an existing post replaces its whole body (Ghost re-creates the Lexical content).

## Deploy behind Traefik

1. Put this folder next to your compose file as `./ghost-mcp`.
2. Merge the service from [`docker-compose.example.yml`](docker-compose.example.yml) (build from
   `./ghost-mcp`, `expose` only, same Docker network as Traefik and Ghost, **no basicauth middleware**).
3. Add to `.env` (see [`.env.example`](.env.example)), then `chmod 600 .env`:
   ```
   GHOST_URL=https://your-blog.example
   GHOST_ADMIN_KEY=<new key>
   MCP_SECRET=$(openssl rand -hex 32)
   ENABLE_DELETE=false
   ```
4. `docker compose up -d --build mcp && docker compose logs mcp`
5. Connector URL: `https://your-blog.example/mcp/<MCP_SECRET>`

### Verify

```bash
URL=https://your-blog.example/mcp
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

# 401 without the secret
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# site info (reads $MCP_SECRET from your shell, never typed in the command)
curl -s -X POST "$URL/$MCP_SECRET" "${H[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_ghost_site","arguments":{}}}'
```

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| Tool error "redirect ... GHOST_URL must be the exact public URL" | `GHOST_URL` differs from Ghost's configured `url` (scheme, host, subdirectory) |
| `HTTP 401/403` from Ghost, "Invalid token" | Wrong or regenerated Admin key; key must be an *Admin* key, not a Content key |
| Token errors with correct key | Server clock skew (JWTs live 4 minutes) |
| `Could not reach Ghost` | Container cannot resolve/reach the public URL: check DNS and network |
| Traefik 404 | Router rule typo, or `mcp` is not on Traefik's network |

## Development

```bash
npm install
npm test        # builds, then runs the end-to-end suite against a mock Ghost Admin API
```

### Adding a tool

Each tool lives in its own file in `src/tools/`, named after the tool (`list_ghost_tags` is `list-ghost-tags.ts`).
A file default-exports a `ToolModule`: a function that registers the tool, or returns early when the
configuration forbids it (`READ_ONLY`, `ENABLE_DELETE`, `ENABLE_MEMBERS`). Add the file, then add it to the list in
`src/tools/index.ts`. Shared code is in `src/tools/shared/`; posts and pages share builders there, with thin
per-tool files such as `list-ghost-posts.ts`. A test fails if a tool and its file name drift apart.

The test suite verifies the JWT the way Ghost does, and drives the server with the official MCP client.
