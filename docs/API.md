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
| PATCH | `/api/workspace/settings/name` | `{name}` — renames the workspace, admin/owner only. Trimmed, required, 64 characters max. Pushed to every browser over SSE |
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
| PATCH | `/api/spaces/:id` | `{name?, description?, icon?, publicRole?}` (space admin). `publicRole` is `reader`, `writer`, or `null` to turn public access off |
| DELETE | `/api/spaces/:id` | (workspace admin) |
| GET/POST | `/api/spaces/:id/members` | POST `{userId, role: admin\|writer\|reader}`. A member row overrides the space's `public_role` in both directions |
| PATCH/DELETE | `/api/spaces/:id/members/:userId` | |

### Pages
Page `content` is TipTap/ProseMirror JSON (`{"type":"doc","content":[...]}`).
Custom node types: `callout{variant}`, `toggleBlock{title,open}`, `mermaidDiagram{code}`,
`excalidraw{data}`, `drawioDiagram{xml,svg}`, `iframeEmbed{src}`, `videoBlock{src}`,
`footnoteRef{footnoteId}`, `footnote{footnoteId}`, `footnotes`.

Footnotes are three nodes rather than one: an inline `footnoteRef` atom sits in
the prose, a `footnote` block holds the note's content (`block+`, so a note may
be several paragraphs), and a single `footnotes` container collects them. The
container is constrained by the document schema (`block+ footnotes?`) to appear
at most once, as the last child of the document — an API client that writes one
anywhere else will have it rejected.

The two halves are joined by `footnoteId`. **The displayed number is not
stored**: it is derived from the order the references appear in, so a client
writing footnotes never has to number them and never has to renumber them.
Write the pairs, in any order, and leave the numbering alone.

A `drawioDiagram` needs only its `xml` (an mxGraph `<mxfile>`/`<mxGraphModel>`
document) — the `svg` preview is optional. An API client that writes a diagram
usually has no way to produce a picture, so the client renders one on first view
and writes it back to the node. Send `{"xml": "…", "svg": ""}` and the page draws
the same diagram it would have drawn had someone made it in the editor.

Mermaid diagrams are normalised on write: a `codeBlock` whose language is
mermaid (case-insensitive, `mmd` included, info-string attributes ignored) is
stored as a `mermaidDiagram{code}` node, as is an unlabelled code block whose
body opens with a mermaid declaration (`graph TD`, `sequenceDiagram`, …). A
client that sends markdown-derived JSON therefore gets a rendered, editable
diagram rather than raw source in a code block. Draw.io code blocks are
normalised the same way: a ```` ```drawio ```` fence (also `draw.io`, `mxgraph`),
or an unlabelled fence whose body opens with `<mxfile>`/`<mxGraphModel>`, is
stored as a `drawioDiagram{xml}`. A fence that names some other language is left
alone in both cases — a code block someone chose is a code block.

Every block-level node carries a `blockId` attribute. Clients that write documents
are not required to supply one — the server mints ids for any block arriving
without them and stores them back into the document — but a client that *does*
send them gets incremental behaviour: only the blocks whose content actually
changed are rewritten, re-embedded, and reported by the delta endpoint. Sending a
document with ids stripped makes every block look new. See
[docs/block-storage.md](block-storage.md).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/spaces/:id/pages` | Tree metadata (id, parent_id, title, icon, order_key, rev), ordered by `order_key` |
| POST | `/api/pages` | `{spaceId, parentId?, title?}` |
| GET | `/api/pages/:id` | Full page + breadcrumbs + caller's role |
| PATCH | `/api/pages/:id` | `{title?, icon?, content?}` — content triggers versioning, block reprojection and a scoped search reindex. Sent with an API token (MCP, scripts) it also drops the page's collaborative document, so the next reader rebuilds it from the JSON just written instead of being served the pre-write CRDT |
| GET | `/api/pages/:id/subtree?content=1` | The page and every live page beneath it, at any depth, ordered by `order_key`. Reader access is enough — this is what "Export as ZIP" walks. `content=1` includes each page's body; without it only the tree. Trashed pages, and anything beneath them, are left out |
| GET | `/api/pages/:id/blocks` | `{rev, blocks[]}` — the page's blocks in document order |
| GET | `/api/pages/:id/delta?since=N` | What changed since revision `N`: `{rev, full, blocks[], deleted[], order[]}`. `full: true` means the gap is too wide to answer incrementally — refetch the page. |
| POST | `/api/pages/:id/move` | `{parentId?, spaceId?, index?, orderKey?}` — `index` is the slot among the destination's children, resolved server-side; `spaceId` moves the subtree to another space (needs writer on both). `orderKey` is an explicit sort key for clients that compute one. A numeric `position` is still accepted and read as a slot index. |
| POST | `/api/pages/move-many` | `{pageIds[], parentId?, spaceId?, index?}` — moves a whole selection into one slot. `pageIds` is in the order the pages should end up; the destination gap is split into that many order keys before anything is written, so the batch keeps its order. The batch is validated as a whole first, so a drop that breaks the nesting rule is refused entirely rather than half applied. |
| DELETE | `/api/pages/:id` | Soft-delete subtree (trash) |
| POST | `/api/pages/delete-many` | `{pageIds[]}` — soft-delete several subtrees in one statement; returns `{trashed}`, the number of pages that went to the trash including subpages |
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
