#!/usr/bin/env bash
# Cut a release by hand.
#
# You normally do not need this. Pushing to main runs
# .github/workflows/docker-publish.yml, which bumps the versions, commits the
# bump, tags `v<release>`, and publishes the image — see scripts/bump-version.sh
# for how the bump size and the affected packages are worked out.
#
# This script is the escape hatch for the cases automation does not cover:
# re-cutting a release from an older commit, or forcing a specific version.
#
#   1. edit "version" in package.json (and server/ or client/ if you mean to)
#   2. commit that change
#   3. ./scripts/release.sh          # tags v<version> and pushes
#
# Actions then builds and pushes ghcr.io/<owner>/diomedes with tags
# :<version>, :<major>.<minor>, and :sha-<short>. Servers running :latest pick
# the new image up via watchtower within a minute.
#
# Note that server/ and client/ versions are deliberately allowed to differ —
# a change to one does not move the other. Only the release version in the root
# package.json describes the image as a whole.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
SERVER_VERSION=$(node -p "require('./server/package.json').version")
CLIENT_VERSION=$(node -p "require('./client/package.json').version")
TAG="v${VERSION}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit the version bump first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "error: tag ${TAG} already exists — bump the version first" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Releasing ${TAG} from ${BRANCH} (server ${SERVER_VERSION}, client ${CLIENT_VERSION}) ..."
git tag -a "${TAG}" -m "Diomedes ${VERSION}"
git push origin "${BRANCH}" "${TAG}"

echo
echo "Pushed ${TAG}. Watch the build:"
echo "  gh run watch  (or https://github.com/$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')/actions)"
