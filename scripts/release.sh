#!/usr/bin/env bash
# Cut a release. Images are built and published by GitHub Actions
# (.github/workflows/docker-publish.yml), not on your laptop.
#
# Release flow:
#   1. bump "version" in server/package.json (and client/package.json to match)
#   2. commit that change
#   3. ./scripts/release.sh          # tags v<version> and pushes
#
# Actions then builds and pushes ghcr.io/<owner>/diomedes with tags
# :<version>, :<major>.<minor>, :sha-<short>, and — for builds on the default
# branch — :latest. Servers running the :latest tag pick the new image up via
# watchtower within a minute; nothing else to do.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./server/package.json').version")
CLIENT_VERSION=$(node -p "require('./client/package.json').version")
TAG="v${VERSION}"

if [[ "$VERSION" != "$CLIENT_VERSION" ]]; then
  echo "error: server/package.json is $VERSION but client/package.json is $CLIENT_VERSION" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit the version bump first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "error: tag ${TAG} already exists — bump the version first" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Releasing ${TAG} from ${BRANCH} ..."
git tag -a "${TAG}" -m "Diomedes ${VERSION}"
git push origin "${BRANCH}" "${TAG}"

echo
echo "Pushed ${TAG}. Watch the build:"
echo "  gh run watch  (or https://github.com/$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')/actions)"
