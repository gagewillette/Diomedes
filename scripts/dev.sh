#!/usr/bin/env bash
# Spins up local Postgres/Redis (bind-mounted under ./data), then runs the
# server and client dev servers, and opens the app once Vite is ready.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/db data/redis data/storage

# Optional local overrides (.env is gitignored). For hybrid search with no API
# key, run Ollama and set in .env:
#   SEMANTIC_SEARCH_ENABLED=true
#   EMBEDDING_API_URL=http://localhost:11434/v1/embeddings
#   EMBEDDING_MODEL=nomic-embed-text
#   EMBEDDING_DIMENSIONS=768
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

docker compose -f docker-compose.dev.yml up -d --wait

export DATABASE_URL="${DATABASE_URL:-postgresql://diomedes:dev@localhost:5432/diomedes}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export APP_SECRET="${APP_SECRET:-dev-secret-do-not-use-in-prod}"
export STORAGE_PATH="${STORAGE_PATH:-$(pwd)/data/storage}"
export PORT="${PORT:-3000}"
export SEMANTIC_SEARCH_ENABLED="${SEMANTIC_SEARCH_ENABLED:-false}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export EMBEDDING_API_URL="${EMBEDDING_API_URL:-}"
export EMBEDDING_MODEL="${EMBEDDING_MODEL:-}"
export EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-}"

npx --yes concurrently -k -n SERVER,CLIENT -c "blue,magenta" \
  "npm --prefix server run dev" \
  "npm --prefix client run dev" &
CONC_PID=$!

(npx --yes wait-on http://localhost:5173 && open http://localhost:5173) &

wait "$CONC_PID"
