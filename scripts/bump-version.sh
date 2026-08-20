#!/usr/bin/env bash
# Work out how much to bump, and bump it.
#
# The repo carries three versions:
#
#   package.json          the *release* version — what the Docker image is tagged
#                         with, and what `v<x.y.z>` git tags point at. Moves
#                         whenever anything that lands in the image changes.
#   server/package.json   the server component. Moves only when server/ changes.
#   client/package.json   the client component. Moves only when client/ changes.
#
# Component versions are free to diverge — a client-only change moves the client
# and leaves the server where it is. Only the release version has to stay
# coherent, because server and client ship inside a single image.
#
# Bump size comes from the commit messages in the range. Default is a patch; a
# commit saying `[minor]` or `feat:` makes it a minor, and `[major]`,
# `BREAKING CHANGE`, or `feat!:` makes it a major. The largest wins.
#
#   ./scripts/bump-version.sh                # dry run — print what would happen
#   ./scripts/bump-version.sh --apply        # rewrite the package.json files
#   ./scripts/bump-version.sh --base <ref>   # compare against <ref> instead of
#                                            # the most recent v* tag
set -euo pipefail
cd "$(dirname "$0")/.."

APPLY=0
BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --base)  BASE="${2:?--base needs a ref}"; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; exit 2 ;;
  esac
done

# Default base: the most recent release tag reachable from HEAD. Comparing
# against the last release rather than the last push means a skipped or failed
# run heals itself on the next push instead of dropping those changes.
if [[ -z "$BASE" ]]; then
  BASE=$(git describe --tags --match 'v*' --abbrev=0 HEAD 2>/dev/null || true)
fi
if [[ -z "$BASE" ]] || ! git rev-parse -q --verify "${BASE}^{commit}" >/dev/null; then
  BASE=$(git rev-parse HEAD~1 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)
fi

RANGE="${BASE}..HEAD"
CHANGED=$(git diff --name-only "$RANGE" || true)
MESSAGES=$(git log --format='%B' "$RANGE" || true)

# --- how big a bump? ---------------------------------------------------------
LEVEL=patch
if grep -qiE '(^|[[:space:]])\[minor\]|^[[:space:]]*feat(\([^)]*\))?:' <<<"$MESSAGES"; then
  LEVEL=minor
fi
if grep -qiE '(^|[[:space:]])\[major\]|BREAKING[ -]CHANGE|^[[:space:]]*[a-z]+(\([^)]*\))?!:' <<<"$MESSAGES"; then
  LEVEL=major
fi

# --- which packages moved? ---------------------------------------------------
changed_in() { grep -qE "^$1" <<<"$CHANGED"; }

server_bump=""
client_bump=""
release_bump=""
changed_in 'server/' && server_bump="$LEVEL"
changed_in 'client/' && client_bump="$LEVEL"
# The release version tracks the image, so it also moves for a Dockerfile change
# even when neither component's source did.
if [[ -n "$server_bump" || -n "$client_bump" ]] || changed_in 'Dockerfile'; then
  release_bump="$LEVEL"
fi

# Reads a version without needing the package installed anywhere.
current() { node -p "require('./${1}package.json').version || '0.0.0'"; }

next() {
  node -e '
    const [a, b, c] = process.argv[1].split(".").map(Number);
    const bumped = { major: [a + 1, 0, 0], minor: [a, b + 1, 0], patch: [a, b, c + 1] };
    process.stdout.write(bumped[process.argv[2]].join("."));
  ' "$1" "$2"
}

# npm version rewrites package.json *and* the lockfile's version fields, which
# matters because the Dockerfile installs with `npm ci`.
apply_bump() { ( cd "$1" && npm version "$2" --no-git-tag-version --allow-same-version >/dev/null ); }

emit() {
  echo "${1}=${2}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "${1}=${2}" >>"$GITHUB_OUTPUT"; fi
}

echo "base:  ${BASE} ($(git rev-parse --short "$BASE"))"
echo "range: ${RANGE}"
echo "level: ${LEVEL}"
echo

if [[ -z "$release_bump" ]]; then
  echo "No server/, client/, or Dockerfile changes in range — nothing to bump."
  emit bumped false
  exit 0
fi

for entry in ":release" "server/:server" "client/:client"; do
  dir="${entry%%:*}"
  name="${entry##*:}"
  var="${name}_bump"
  level="${!var}"
  before=$(current "$dir")

  if [[ -z "$level" ]]; then
    echo "  ${name}: ${before} (unchanged)"
    emit "${name}_version" "$before"
    emit "${name}_bumped" false
    continue
  fi

  if [[ "$APPLY" == 1 ]]; then
    apply_bump "${dir:-.}" "$level"
    after=$(current "$dir")
  else
    after=$(next "$before" "$level")
  fi
  echo "  ${name}: ${before} -> ${after} (${level})"
  emit "${name}_version" "$after"
  emit "${name}_bumped" true
done

emit bumped true
if [[ "$APPLY" != 1 ]]; then echo; echo "(dry run — pass --apply to write these)"; fi
