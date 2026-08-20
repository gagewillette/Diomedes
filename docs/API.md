# Diomedes REST API

The full application API, usable by external clients — this is the layer a future
**MCP server** should sit on. Everything the web UI does goes through these endpoints.

## Authentication

Two interchangeable mechanisms; every endpoint accepts both:

1. **Session cookie** — what the browser uses (`POST /api/auth/login`).
2. **API token (for MCP / scripts)** — create one in *Settings → API tokens*, then send:

```
Authorization: Bearer dio_xxxxxxxxxxxxxxxxx
```

Tokens act as the user who created them — same role, same space scoping. Only the
SHA-256 hash is stored server-side; the plaintext is shown once at creation.
Tokens cannot create other tokens. Revoke any time from Settings.

```bash
curl -H "Authorization: Bearer $DIOMEDES_TOKEN" https://docs.gageserver.net/api/pages/recent
```

Errors are JSON: `{"error": "message"}` with proper status codes (401/403/404/400/429).

## Endpoints

### Auth & profile
| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/me` | Current user + workspace name + workspace settings + preferences |
| PATCH | `/api/auth/preferences` | `{preferences: {...}}` — user-scoped UI/editor prefs (≤8KB) |
| PATCH | `/api/auth/profile` | `{name}` |
| POST | `/api/auth/change-password` | `{current, next}` (session only) |

### Workspace settings
| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspace/settings` | `{workspace: {name, dataSavings: {livePointers, fileUploads}, performance: {logging, sampleRate}}}` — any member |
| PATCH | `/api/workspace/settings/data-savings` | `{dataSavings: {livePointers?, fileUploads?}}`, booleans, admin/owner only. Flags are positive: `false` turns the capability **off**. With `fileUploads: false` both upload endpoints answer 403; stored files keep being served |
| PATCH | `/api/workspace/settings/performance` | `{performance: {logging?: bool, sampleRate?: 0..1}}`, admin/owner only. `logging: false` stops all sample collection, client and server |
| GET | `/api/workspace/info` | Workspace inventory: content counts, 7-day activity, per-space breakdown, storage (attachments, disk, database, per-table) and runtime (node, uptime, memory, db pool, search mode). Admin/owner only |

### Performance logging
Timing samples are recorded by the browser and by the server, stored raw in `perf_samples`, and rolled up on read. Collection stops entirely when `performance.logging` is off. Samples are kept for `PERF_RETENTION_DAYS` (default 14) and pruned daily.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/perf/samples` | `{samples: [{kind, name?, durationMs, serverMs?, transferBytes?, encodedBytes?, decodedBytes?, status?, detail?}]}` — any member (it is their own browser being measured). `kind` ∈ `navigation`, `route`, `interaction`, `longtask`, `api`, `resource`, `vital`; unknown kinds are dropped rather than stored. Max 200 per batch. Answers `{enabled, stored, sampleRate}`; `enabled: false` means logging is off and the batch was discarded |
| GET | `/api/perf/overview?window=1h\|24h\|7d\|30d` | Computed panel: headline metrics with p50/p75/p95/p99 and budget verdicts, reliability, slowest routes and screens, data transfer, and a bucketed timeline. Admin/owner only |
| DELETE | `/api/perf/samples?mode=all\|expired` | Clear every sample, or only those past the retention window. Admin/owner only |

Every response carries a `Server-Timing: app;dur=<ms>` header, which the browser reads to split a round trip into server time vs. network time.

### API tokens (session only for creation)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/tokens` | List own tokens (id, name, created_at, last_used_at) |
| POST | `/api/tokens` | `{name}` → `{token}` returned **once** |
| DELETE | `/api/tokens/:id` | Revoke |

### Spaces
| Method | Path | Notes |
|---|---|---|
| GET | `/api/spaces` | Spaces visible to the caller, with `my_role` |
| POST | `/api/spaces` | `{name, description?, icon?}` (workspace admin) |
| GET | `/api/spaces/:slug` | Lookup by slug |
| PATCH | `/api/spaces/:id` | (space admin) |
| DELETE | `/api/spaces/:id` | (workspace admin) |
| GET/POST | `/api/spaces/:id/members` | POST `{userId, role: admin\|writer\|reader}` |
| PATCH/DELETE | `/api/spaces/:id/members/:userId` | |

### Pages
Page `content` is TipTap/ProseMirror JSON (`{"type":"doc","content":[...]}`).
Custom node types: `callout{variant}`, `toggleBlock{title,open}`, `mermaidDiagram{code}`,
`excalidraw{data}`, `drawioDiagram{xml,svg}`, `iframeEmbed{src}`, `videoBlock{src}`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/spaces/:id/pages` | Tree metadata (id, parent_id, title, icon, position) |
| POST | `/api/pages` | `{spaceId, parentId?, title?}` |
| GET | `/api/pages/:id` | Full page + breadcrumbs + caller's role |
| PATCH | `/api/pages/:id` | `{title?, icon?, content?}` — content triggers versioning + search reindex |
| POST | `/api/pages/:id/move` | `{parentId?, spaceId?, index?, position?}` — `index` is the slot among the destination's children, resolved server-side; `spaceId` moves the subtree to another space (needs writer on both). `position` is the older explicit sort key. |
| DELETE | `/api/pages/:id` | Soft-delete subtree (trash) |
| POST | `/api/pages/:id/restore` | |
| DELETE | `/api/pages/:id/permanent` | (space admin) |
| GET | `/api/spaces/:id/trash` | |
| GET | `/api/pages/recent` | Recent pages across caller's spaces |
| GET | `/api/search?q=…&space=…` | Full-text; snippets mark hits with `[[[` `]]]` |

### Versions, comments, favorites, sharing
| Method | Path |
|---|---|
| GET | `/api/pages/:id/versions` · GET `/api/pages/:id/versions/:vid` · POST `…/:vid/restore` |
| GET/POST | `/api/pages/:id/comments` · PATCH/DELETE `/api/comments/:id` |
| GET | `/api/favorites` · PUT/DELETE `/api/pages/:id/favorite` |
| POST/DELETE | `/api/pages/:id/share` → `{token}`; public read at GET `/api/public/:token` |

### Files
| Method | Path | Notes |
|---|---|---|
| POST | `/api/pages/:id/attachments` | multipart field `file` → `{url}`. 403 when workspace file uploads are off |
| GET | `/api/files/:id/:filename` | Auth or public-if-page-shared |

## MCP server sketch

A Diomedes MCP server needs only this API + one token. Natural tool mapping:

- `search_pages(query)` → GET /api/search
- `read_page(id)` → GET /api/pages/:id (return markdown-ified content)
- `create_page(space, title, markdown)` → POST /api/pages + PATCH content
- `update_page(id, markdown)` → PATCH /api/pages/:id
- `list_spaces()` → GET /api/spaces
- `recent_pages()` → GET /api/pages/recent
- `comment(page_id, text)` → POST /api/pages/:id/comments

Base URL inside the LAN: `http://localhost:3000`; via tunnel: `https://docs.gageserver.net`.
