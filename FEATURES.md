# Diomedes — Docmost Feature Mapping

Research summary of what Docmost offers (from docmost.com/docs and the GitHub README),
and how Diomedes covers each capability. Diomedes is a from-scratch implementation —
no Docmost code is reused (Docmost is AGPL; this avoids any licensing entanglement).

## Editor

| Docmost capability | Diomedes |
|---|---|
| Rich-text editor (TipTap/ProseMirror) | ✅ Same foundation: TipTap 2 |
| Markdown paste with auto-formatting | ✅ Pasted markdown converts to rich blocks (tiptap-markdown) |
| Markdown input shortcuts (`#`, `-`, `1.`, `[ ]`, `>`, ``` ` ``` , `---`, `**bold**`…) | ✅ |
| Slash command menu (`/`) | ✅ Text, H1–H3, lists, to-do, quote, code, divider, table, image, video, file, callout, toggle, footnote, math, Mermaid, Excalidraw, Draw.io, YouTube, iframe embed |
| Floating format toolbar on selection | ✅ Bold/italic/underline/strike/code/link/highlight/color/alignment, block type |
| Tables (resize, row/col ops, header) | ✅ TipTap tables with column resizing and row/col menu |
| Code blocks with syntax highlighting | ✅ highlight.js via lowlight (grammars loaded per language, on demand), searchable language picker, copy, soft wrap, line numbers, and opt-in per-language checking (JSON, YAML, SQL, Python, JavaScript) behind a workspace toggle |
| Task lists / to-do | ✅ |
| Callouts (info/warning/danger/success) | ✅ Custom node |
| Toggle blocks | ✅ Custom collapsible node |
| Footnotes | ✅ `/footnote`, `[^` picker or inline `^[text]`. Auto-numbered superscript markers, notes collected at the foot of the page, click to jump, hover to preview, `↩` back-links. Exports and imports as Obsidian/GFM `[^1]` markdown |
| Math (inline + block, KaTeX) | ✅ KaTeX rendering of `$…$` |
| Mermaid diagrams | ✅ Live-rendered Mermaid node with code editor |
| Excalidraw diagrams | ✅ Full Excalidraw editor in a modal, scene stored in the doc |
| Draw.io diagrams | ✅ Full diagrams.net editor in a modal (embed.diagrams.net postMessage integration); XML + SVG preview stored in the doc. XML pushed in over the API/MCP (```drawio fence) is rendered on first view |
| Images / video / file attachments | ✅ Upload to server-local storage, drag-drop and paste images |
| PDF / PowerPoint documents | ✅ `/document` or drag-drop inserts a document bar. PDFs open in the browser's native viewer in a new tab; a PPTX is stored as-is (download only) or converted to PDF server-side on upload. Stored under a per-user directory |
| Embeds (YouTube, iframe → Airtable/Loom/Miro/Figma/etc.) | ✅ YouTube node + generic iframe embed node (paste any embed URL) |
| @-mention users | ✅ |
| @-mention pages | ➖ Use normal links to pages |
| Emoji `:search:` | ➖ Use OS emoji picker (Win+. / Cmd+Ctrl+Space) |
| Find & replace in page | ➖ Browser Ctrl+F works for finding |
| Text color / highlight color | ✅ |
| Sub/superscript, underline, strikethrough | ✅ |
| Drag handle block reordering | ✅ Hover grip to the left of any block; drag to reorder, or Alt+Shift+↑/↓. The move is saved as a new fractional order key on the one block that moved |
| Synced blocks, Status chips, Date chip, Subpages block, page labels | ➖ Not in v1 |
| AI features | ➖ Intentionally excluded |

## Collaboration & content management

| Docmost capability | Diomedes |
|---|---|
| Real-time multi-cursor co-editing (Yjs/Hocuspocus) | ✅ Yjs CRDT over a websocket at `/api/collab/<pageId>`, persisted to postgres and mirrored between app processes over Redis. Live carets while typing, Miro-style mouse pointers while reading, colours derived from the user id — see [docs/realtime-collaboration.md](docs/realtime-collaboration.md) |
| Comments (inline, threaded) | ✅ Threaded comments with resolve, page-level or anchored to a highlighted phrase; hovering an anchored comment jumps to and highlights its text |
| Page history & version restore | ✅ Automatic snapshots (max one per 10 min of editing) + restore |
| Find in page (Ctrl/⌘+F) | ✅ Overrides the browser's find — literal or regular-expression search with match counter, next/previous, case toggle and in-place highlighting; works on shared read-only pages too |
| Full-text search | ✅ Postgres tsvector + GIN index, ranked results with highlighted snippets, scoped to your accessible spaces |
| Semantic / AI search | ✅ Optional (`SEMANTIC_SEARCH_ENABLED`) — pgvector embeddings fused with full-text by reciprocal rank fusion, embedded in the background on save, falls back to full-text if the API is down |
| Trash / restore pages | ✅ Soft-delete with per-space trash, restore, permanent delete. Space admins can empty the whole trash at once, after retyping a four-letter phrase generated for that prompt |
| Favorites / starred pages | ✅ |
| Recently updated pages | ✅ Home dashboard |
| PDF export / printing | ✅ Print stylesheet (browser Print → PDF) |
| Import: Markdown / HTML / Notion zip | ✅ Markdown file import (client-side parse), into a space or under a top-level page. Notion/Confluence zips ➖ |
| Export: Markdown / HTML | ✅ Per-page export to .md and .html |
| Export: page subtree as ZIP | ✅ A page and every page nested under it, at any depth, as one flat archive of markdown files with YAML frontmatter. Available to readers |
| Public page sharing via link | ✅ Token links, revocable, read-only, no login needed; links to pages that are shared too keep the guest on the public side, and links to private pages still ask them to sign in. Revoking closes the page in every viewer that already has it open, and sharing again reopens it on the same link — in both directions, without a refresh |
| Translations (10+ languages) | ➖ English only |
| Dark mode / themes | ✅ Light/dark toggle |

## Organization, users & permissions

| Docmost capability | Diomedes |
|---|---|
| Workspaces | ✅ Single workspace (this is a personal server) |
| Spaces (team/topic separation) | ✅ Spaces with icon, description, slug |
| Nested page tree with reordering | ✅ Nesting to any depth (capped at 20 levels), drag-and-drop reordering and reparenting (including between spaces), move up/down/indent/outdent + move-to-space |
| Multi-select in the page tree | ✅ ⌘/Ctrl-click to pick pages out, Shift-click for a range. A selection drags as one pile and keeps its order on the drop; trashing one asks first |
| Groups | ➖ Direct per-user space membership instead (small user count) |
| Workspace roles (Owner / Admin / Member) | ✅ owner / admin / member |
| Space roles (Full access / Can edit / Can view) | ✅ admin / writer / reader per space, set by admins |
| Public space access | ✅ a space can grant every signed-in user view or edit access by default; a member's own role always overrides it, up or down |
| Email invitations + SMTP | ✅→ Replaced by direct admin user creation with username + password (no SMTP dependency; your docmost SMTP was never configured anyway) |
| SSO/OIDC/MFA (Enterprise) | ➖ Username/password sessions (Redis-backed), login rate limiting |
| Deactivate users | ✅ |
| Admin password reset | ✅ |
| Page-level permissions (Enterprise) | ➖ Space-level scoping only |
| API & MCP | ✅ Bearer API tokens (Settings → API tokens) work on every endpoint alongside sessions; full surface documented in docs/API.md with an MCP tool sketch |
| User preferences (docmost: theme/language) | ✅ Per-user editor prefs: font, size, line spacing, page width, smooth caret, animations |
| Workspace-wide settings | ✅ Settings → Workspace settings (admins only): **Data savings** — turn off live pointers, turn off file uploads (existing files keep working when uploads are off); **Uploads** — the largest single file anyone can upload (1 MB–512 MB, 512 MB by default; oversized files are refused in the browser, before anything is sent); **Performance** — turn off performance logging, or sample it down |
| Performance panel | ✅ Workspace info (owners/admins): page-open, interaction, API and server latency as p50/p75/p95/p99 against explicit budgets, web vitals (LCP/INP/CLS/FCP/TTFB), long tasks, error rate, data transfer from both the server and the browser, per-route and per-screen breakdowns, plus workspace content, storage and runtime figures |

## Infrastructure parity

| Docmost deployment trait | Diomedes |
|---|---|
| Node.js app container | ✅ node:22-alpine, multi-stage build from source in `server/` + `client/` |
| PostgreSQL 16 | ✅ same image (postgres:16-alpine) |
| Redis 7 | ✅ same image (redis:7-alpine), holds sessions + rate limits |
| Local file storage volume | ✅ /mnt/storage/diomedes/app-data ↔ /app/data/storage |
| DB/Redis volumes on /mnt/storage | ✅ /mnt/storage/diomedes/{db,redis} |
| APP_URL / APP_SECRET / DATABASE_URL / REDIS_URL env | ✅ same variable names |
| Cloudflare tunnel exposure | ✅ Serves plain HTTP on host port 3000; TLS terminates at Cloudflare (same as docmost) |
