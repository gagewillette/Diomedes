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
| GET | `/api/auth/me` | Current user + workspace name + preferences |
| PATCH | `/api/auth/preferences` | `{preferences: {...}}` — user-scoped UI/editor prefs (≤8KB) |
| PATCH | `/api/auth/profile` | `{name}` |
| POST | `/api/auth/change-password` | `{current, next}` (session only) |

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
| POST | `/api/pages/:id/move` | `{parentId?, position?}` |
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
| POST | `/api/pages/:id/attachments` | multipart field `file` → `{url}` |
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
