#!/usr/bin/env bash
# Spins up local Postgres/Redis (bind-mounted under ./data), then runs the
# server and client dev servers, and opens the app once Vite is ready.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/db data/redis data/storage

docker compose -f docker-compose.dev.yml up -d --wait

export DATABASE_URL="postgresql://diomedes:dev@localhost:5432/diomedes"
export REDIS_URL="redis://localhost:6379"
export APP_SECRET="dev-secret-do-not-use-in-prod"
export STORAGE_PATH="$(pwd)/data/storage"
export PORT="3000"

npx --yes concurrently -k -n SERVER,CLIENT -c "blue,magenta" \
  "npm --prefix server run dev" \
  "npm --prefix client run dev" &
CONC_PID=$!

(npx --yes wait-on http://localhost:5173 && open http://localhost:5173) &

wait "$CONC_PID"
