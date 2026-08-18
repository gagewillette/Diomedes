# Diomedes

A self-hosted wiki & note-taking app in the spirit of Docmost/Notion, built from
scratch. React + Mantine + TipTap frontend, Express + PostgreSQL + Redis backend,
shipped as a single versioned Docker image.

**Editor**: markdown paste with auto-formatting, markdown typing shortcuts, slash
commands, Word-style smooth caret, tables, task lists, syntax-highlighted code, KaTeX
math, callouts, toggles, YouTube/iframe embeds, image/video/file uploads — and three
integrated diagram editors: **Mermaid**, **Excalidraw**, and **Draw.io**.

**Organization**: spaces with nested page trees, full-text search, favorites, page
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
├── scripts/release.sh # builds diomedes:<version> + :latest
├── Dockerfile         # multi-stage: build client → install server deps → runtime
└── docker-compose.yml # diomedes + postgres:16-alpine + redis:7-alpine
```

## Running

```bash
cp .env.example .env   # fill in APP_SECRET + POSTGRES_PASSWORD
docker compose up -d --build
```

The app listens on **port 3000**. First visit shows a one-time setup screen that
creates the owner account and workspace.

Data lives in bind mounts (adjust paths in `docker-compose.yml` to taste):

| Path | Purpose |
|---|---|
| `/mnt/storage/diomedes/db` | PostgreSQL data |
| `/mnt/storage/diomedes/redis` | Redis persistence (sessions survive restarts) |
| `/mnt/storage/diomedes/app-data` | Uploaded files/attachments |

## Versioning & releases

Images are tagged semver from `server/package.json`:

```bash
./scripts/release.sh        # builds diomedes:1.1.0 and diomedes:latest
```

Then set `DIOMEDES_VERSION` in `.env` and `docker compose up -d`. Compose runs the
pinned tag, so rolling back is `DIOMEDES_VERSION=<old> docker compose up -d`.

## HTTPS via Cloudflare tunnel

TLS terminates at Cloudflare's edge; the tunnel forwards to plain HTTP locally, so no
certificates live on the server. In **Zero Trust → Networks → Tunnels**, point a
public hostname (e.g. `docs.gageserver.net`) at `HTTP → localhost:3000`, and keep
`APP_URL` in `.env` matching that hostname.

## Ops cheatsheet

```bash
docker compose logs -f diomedes        # app logs
./scripts/release.sh                   # build a new versioned image
docker exec -it diomedes-db psql -U diomedes diomedes   # db shell
docker exec diomedes-db pg_dump -U diomedes diomedes > backup.sql
```
