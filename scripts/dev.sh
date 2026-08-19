#!/usr/bin/env bash
# Spins up local Postgres/Redis (bind-mounted under ./data), then runs the
# server and client dev servers, and opens the app once Vite is ready.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/db data/redis data/storage data/ollama

# Optional local overrides (.env is gitignored). For hybrid search, the only
# line you need is:
#   SEMANTIC_SEARCH_ENABLED=true
# That starts a containerized Ollama which downloads its own embedding model —
# nothing to install on the host. Set OPENAI_API_KEY instead to use OpenAI.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

export SEMANTIC_SEARCH_ENABLED="${SEMANTIC_SEARCH_ENABLED:-false}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export EMBEDDING_API_URL="${EMBEDDING_API_URL:-}"
export EMBEDDING_MODEL="${EMBEDDING_MODEL:-}"
export EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-}"

# Semantic search with no OpenAI key means the local Ollama container. Turn its
# compose profile on and fill in the matching client config, so one env var is
# the whole switch.
if [ "$SEMANTIC_SEARCH_ENABLED" = "true" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$EMBEDDING_API_URL" ]; then
  export COMPOSE_PROFILES="${COMPOSE_PROFILES:-ollama}"
  export EMBEDDING_API_URL="http://localhost:11434/v1/embeddings"
  export EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"
  export EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-768}"
fi

# If something already answers on 11434 — an Ollama you installed on the host —
# leave it alone and use it. Starting the container would just fail to bind the
# port. Stop the host service to switch over to the container.
if [ "${COMPOSE_PROFILES:-}" = "ollama" ] && (exec 3<>/dev/tcp/127.0.0.1/11434) 2>/dev/null; then
  exec 3<&- 2>/dev/null || true
  echo "note: something is already serving :11434 — using it instead of the ollama container"
  echo "      (stop the host Ollama and re-run to use the container)"
  COMPOSE_PROFILES=""
fi
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"

# `ollama` is how the app reaches the container in a compose deployment; here
# the server runs on the host, so the same .env value has to point at the
# published port instead.
EMBEDDING_API_URL=$(printf '%s' "$EMBEDDING_API_URL" | sed 's|//ollama:|//localhost:|')
export EMBEDDING_API_URL

# --wait blocks on healthchecks; on the first run with the ollama profile that
# includes the model download, so this can sit for a few minutes once.
if [ -n "${COMPOSE_PROFILES:-}" ]; then
  echo "starting dev services (profiles: $COMPOSE_PROFILES) — first ollama run downloads ${EMBEDDING_MODEL:-the embedding model}"
fi
docker compose -f docker-compose.dev.yml up -d --wait

export DATABASE_URL="${DATABASE_URL:-postgresql://diomedes:dev@localhost:5432/diomedes}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export APP_SECRET="${APP_SECRET:-dev-secret-do-not-use-in-prod}"
export STORAGE_PATH="${STORAGE_PATH:-$(pwd)/data/storage}"
export PORT="${PORT:-3000}"

npx --yes concurrently -k -n SERVER,CLIENT -c "blue,magenta" \
  "npm --prefix server run dev" \
  "npm --prefix client run dev" &
CONC_PID=$!

(npx --yes wait-on http://localhost:5173 && open http://localhost:5173) &

wait "$CONC_PID"
