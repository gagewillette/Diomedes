#!/usr/bin/env bash
# Build the Diomedes image tagged with the version from server/package.json
# (plus :latest), e.g.  diomedes:1.1.0
#
# Release flow:
#   1. bump "version" in server/package.json (and client/package.json to match)
#   2. ./scripts/release.sh
#   3. set DIOMEDES_VERSION in .env to the new version
#   4. docker compose up -d
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./server/package.json').version")
echo "Building diomedes:${VERSION} ..."
docker build -t "diomedes:${VERSION}" -t diomedes:latest .
echo "Done: diomedes:${VERSION}  diomedes:latest"
docker image ls diomedes --format '  {{.Repository}}:{{.Tag}}  ({{.Size}})'
