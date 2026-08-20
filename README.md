# Diomedes

A self-hosted wiki & note-taking app in the spirit of Docmost/Notion, built from
scratch. React + Mantine + TipTap frontend, Express + PostgreSQL + Redis backend,
shipped as a single versioned Docker image.

**Editor**: markdown paste with auto-formatting, markdown typing shortcuts, slash
commands, Word-style smooth caret, tables, task lists, syntax-highlighted code, KaTeX
math, callouts, toggles, YouTube/iframe embeds, image/video/file uploads,
**PDF and PowerPoint documents** — and three integrated diagram editors:
**Mermaid**, **Excalidraw**, and **Draw.io**.

**Live collaboration**: several people edit the same page at once, backed by a Yjs
CRDT over a websocket. You see a colleague's **text caret** while they type and their
**mouse pointer**, Miro-style, while they read or select — with a colour derived from
their user id, so the same person is the same colour for everyone. See
[docs/realtime-collaboration.md](docs/realtime-collaboration.md) for the design and
the concurrency reasoning behind it.

**Block storage**: every block in a document carries a stable id, and a projection
of those blocks is derived from the page inside the same transaction that stores
it. A save that changes one paragraph re-embeds one chunk instead of the whole
page, and `GET /api/pages/:id/delta?since=` answers "what changed" without
shipping the document. See [docs/block-storage.md](docs/block-storage.md).

**Organization**: spaces with nested page trees, full-text search (optionally
**semantic** — see below), favorites, page
history with restore, threaded comments, trash, public share links, Markdown
import/export, dark mode.

**Access control**: username/password auth (bcrypt + Redis sessions), workspace roles
(owner/admin/member) and per-space roles (full access / can edit / can view), admin
user management. Per-user editor preferences (font, size, spacing, width, animations).

**API**: every endpoint accepts a session cookie *or* a personal API token
(`Authorization: Bearer dio_…`, created in Settings) — built to hang an MCP server
off of. See [docs/API.md](docs/API.md). Full feature mapping against Docmost lives
in [FEATURES.md](FEATURES.md).

## Layout

```
diomedes/
├── client/            # React SPA (Vite, Mantine UI, TipTap editor)
├── server/            # Express API (ESM, no build step)
├── scripts/release.sh # tags a release; GitHub Actions builds & publishes
├── Dockerfile         # multi-stage: build client → install server deps → runtime
└── docker-compose.example.yml  # diomedes + postgres + redis + watchtower
```

Your real `docker-compose.yml` is gitignored — it holds host-specific mount paths
and belongs on the server, not in this repo.

## Running

```bash
cp docker-compose.example.yml docker-compose.yml   # adjust volumes to taste
cp .env.example .env                               # fill in APP_SECRET + POSTGRES_PASSWORD
docker compose up -d
```

The image is pulled from `ghcr.io/gagewillette/diomedes` — no local build needed.

The app listens on **port 3000**. First visit shows a one-time setup screen that
creates the owner account and workspace.

The example file uses named volumes; switch them to bind mounts if you want the
data at fixed paths (this is what the author's server does):

| Path | Purpose |
|---|---|
| `/mnt/storage/diomedes/db` | PostgreSQL data |
| `/mnt/storage/diomedes/redis` | Redis persistence (sessions survive restarts) |
| `/mnt/storage/diomedes/app-data` | Uploaded files/attachments (documents under `users/<user-id>/`) |

## Documents (PDF / PowerPoint)

Type `/document`, or drag a file into the page and it lands where you dropped it.
Either way you get a bar on its own line: the filename on the left, download and
view buttons on the right.

- **PDF** — stored as uploaded. *View* opens it in a new tab, where Chrome's
  built-in PDF viewer renders it. There is no in-app viewer to go wrong.
- **PPTX** — you choose on upload whether to keep the original PowerPoint or
  convert it to PDF. Converting happens on the server at upload time, and only
  the PDF is stored. A stored PPTX can be downloaded but never viewed in the
  browser, so its *View* button is disabled.

Documents are stored under `<storage>/users/<user-id>/`, separate from the
per-space layout used by inline images and video. Access is still checked
against the owning page's space, or its public share link.

Conversion shells out to LibreOffice, which the app image installs. Running the
server directly on a host without LibreOffice is fine — the editor detects it,
disables the PDF option, and keeps the PPTX as-is. See `SOFFICE_PATH` in
`.env.example`.

## Semantic search (optional)

Search is Postgres full-text by default: fast, free, and exactly as it has always
worked. Turning semantic search on adds vector similarity alongside it, so
"how do I roll back a release" finds the runbook that only ever says "revert to
the previous tag".

Embeddings come from a local model by default — no API key, no data leaving the
host, and nothing to install. `docker-compose.example.yml` ships an `ollama`
service that downloads its own model on first boot; you turn it on with its
compose profile:

```bash
# .env — the defaults in .env.example already match this
SEMANTIC_SEARCH_ENABLED=true
COMPOSE_PROFILES=ollama
EMBEDDING_API_URL=http://ollama:11434/v1/embeddings
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

`docker compose up -d` then pulls the model (~274 MB) into the `ollama-models`
volume on the first start. The container stays unhealthy until that finishes and
the app waits on it, so no page is ever embedded against a half-downloaded
model. Later starts find the model in the volume and come up in seconds, offline
included. The model is deliberately not auto-updated — swapping it invalidates
every stored vector — so upgrade by hand when you mean to:

```bash
docker compose exec ollama ollama pull nomic-embed-text
```

CPU is enough (~50ms per chunk); there is a commented GPU block in the compose
file for NVIDIA hosts. To use OpenAI instead, clear `COMPOSE_PROFILES` and the
three `EMBEDDING_*` values and set `OPENAI_API_KEY=sk-...` — any other
OpenAI-compatible embedding server works the same way via `EMBEDDING_API_URL`.

`EMBEDDING_DIMENSIONS` must match the model's native width. Changing it means
rebuilding `page_chunks` (`DROP TABLE page_chunks`, restart, then backfill).

It needs the `pgvector/pgvector:pg16` db image (already the default in
`docker-compose.example.yml` — a drop-in replacement that reuses an existing
`postgres:16` volume). After switching it on, embed the pages you already have:

```bash
docker compose exec diomedes npm run backfill:embeddings --prefix server
```

From then on pages are chunked and embedded by a background worker whenever they
are saved, so writes stay fast. Results fuse full-text ranking and vector
similarity by reciprocal rank fusion. If the embedding API is slow or down,
search silently falls back to full-text rather than failing.

`GET /api/health` reports the active mode, how much of the corpus is embedded,
the queue backlog, and the running embedding spend:

```json
{"ok":true,"search":{"mode":"hybrid","coverage":{"total":412,"ready":412,"chunks":1830},
 "queueDepth":0,"embeddings":{"tokens":184320,"estimatedUsd":0.0037}}}
```

Leaving `SEMANTIC_SEARCH_ENABLED=false` costs nothing: no embedding calls, no
background work, no vector tables touched, and with `COMPOSE_PROFILES` empty the
ollama container is never created.

In local dev, `SEMANTIC_SEARCH_ENABLED=true` in `.env` is the whole switch:
`npm run dev` starts the same ollama container, points the server at it on
`localhost:11434`, and blocks on the first model download. Stop any Ollama you
installed on the host first — it holds the same port and the container replaces
it.

## Versioning & releases

Pushing to `main` builds and publishes `ghcr.io/gagewillette/diomedes:latest`.
Tagging cuts a semver release:

```bash
# bump "version" in server/ and client/ package.json, commit, then:
./scripts/release.sh        # tags v1.1.0 and pushes; Actions does the build
```

Published tags: `:latest` (default branch), `:1.1.0`, `:1.1`, `:sha-abc1234`.

## Auto-deployment

`docker-compose.example.yml` includes a **watchtower** container that polls GHCR
every minute and restarts the app when the tag it runs points at a new image.
`--label-enable` means it only touches containers carrying

```yaml
labels:
  com.centurylinklabs.watchtower.enable: "true"
```

so Postgres and Redis — pinned to exact patch versions — are never auto-updated,
along with any unrelated stacks sharing the host. Schema changes are applied by
the app's own idempotent `migrate()` on boot, so an unattended restart is safe.

To pin the deployment instead, set `DIOMEDES_VERSION=1.1.0` in `.env`; watchtower
only ever moves a container to a newer image *under the same tag*, so an explicit
version effectively disables auto-updates. Rolling back is
`DIOMEDES_VERSION=<old> docker compose up -d`.

If you make the GHCR package private, run `docker login ghcr.io` on the host with
a PAT that has `read:packages`, and uncomment the `config.json` mount on the
watchtower service.

### Recovering a lost Postgres password

Postgres only applies `POSTGRES_PASSWORD` when it initializes an empty data
directory — on an existing volume the original password still governs. If it's
lost, reset it against the existing data:

```bash
docker compose stop diomedes
docker compose exec db psql -U postgres -c "ALTER USER diomedes PASSWORD 'new-password';"
# put the same value in .env, then:
docker compose up -d
```

## HTTPS via Cloudflare tunnel

TLS terminates at Cloudflare's edge; the tunnel forwards to plain HTTP locally, so no
certificates live on the server. In **Zero Trust → Networks → Tunnels**, point a
public hostname (e.g. `docs.gageserver.net`) at `HTTP → localhost:3000`, and keep
`APP_URL` in `.env` matching that hostname.

## Ops cheatsheet

```bash
docker compose logs -f diomedes        # app logs
docker compose logs -f watchtower      # what auto-deploy is doing
docker compose pull && docker compose up -d   # deploy now, don't wait for the poll
./scripts/release.sh                   # tag a release; Actions builds it
docker exec -it diomedes-db psql -U diomedes diomedes   # db shell
docker exec diomedes-db pg_dump -U diomedes diomedes > backup.sql
```
