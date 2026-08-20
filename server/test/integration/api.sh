#!/usr/bin/env bash
# End-to-end through the real HTTP API, as a browser and the MCP server see it.
set -euo pipefail
# Point at a server already running against a throwaway database:
#   DATABASE_URL=...  PORT=3111  node src/index.js
#   BASE_URL=http://localhost:3111 test/integration/api.sh
B=${BASE_URL:-http://localhost:3111}
J=$(mktemp -t diomedes-e2e-cookies)
trap 'rm -f "$J"' EXIT

ok() { printf '  ok  %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; exit 1; }
# Every call asserts a 2xx. Without this a handler that 500s after doing its
# database work looks like a pass to any assertion that only reads state back.
api() {
  local body status
  body=$(curl -s -w '\n%{http_code}' -b "$J" -c "$J" -H 'Content-Type: application/json' "$@")
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  case "$status" in
    2*) printf '%s' "$body" ;;
    *) printf '  FAIL HTTP %s from %s\n     %s\n' "$status" "$*" "$body" >&2; exit 1 ;;
  esac
}
# Evaluates a python expression with the JSON response bound to `d`.
jqv() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

api -X POST "$B/api/auth/setup" -d '{"workspaceName":"E2E","name":"Tester","username":"tester","password":"password123"}' > /dev/null
ok "workspace set up"

SPACE=$(api "$B/api/spaces" | jqv "d['spaces'][0]['id']")
ok "space $SPACE"

# ---- a page created through the API, with a body and no block ids ----
BODY='{"type":"doc","content":[
  {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Alpha"}]},
  {"type":"paragraph","content":[{"type":"text","text":"first paragraph"}]},
  {"type":"paragraph","content":[{"type":"text","text":"second paragraph"}]}]}'
PAGE=$(api -X POST "$B/api/pages" -d "{\"spaceId\":\"$SPACE\",\"title\":\"Blocks\",\"content\":$BODY}" | jqv "d['page']['id']")
ok "page created with a body: $PAGE"

BLOCKS=$(api "$B/api/pages/$PAGE/blocks")
N=$(echo "$BLOCKS" | jqv "len(d['blocks'])")
[ "$N" = "3" ] || fail "expected 3 blocks, got $N"
echo "$BLOCKS" | jqv "all(b['block_id'].startswith('blk_') for b in d['blocks'])" | grep -q True || fail "block ids not minted"
echo "$BLOCKS" | jqv "[b['type'] for b in d['blocks']]" | grep -q "heading" || fail "block types wrong"
ok "GET /pages/:id/blocks returns 3 ordered, id-stamped blocks"

REV=$(echo "$BLOCKS" | jqv "d['rev']")
[ "$REV" = "1" ] || fail "expected rev 1, got $REV"
ok "page is at rev 1"

# ---- editing one paragraph ----
ID0=$(echo "$BLOCKS" | jqv "d['blocks'][0]['block_id']")
ID1=$(echo "$BLOCKS" | jqv "d['blocks'][1]['block_id']")
ID2=$(echo "$BLOCKS" | jqv "d['blocks'][2]['block_id']")

EDITED="{\"type\":\"doc\",\"content\":[
  {\"type\":\"heading\",\"attrs\":{\"level\":1,\"blockId\":\"$ID0\"},\"content\":[{\"type\":\"text\",\"text\":\"Alpha\"}]},
  {\"type\":\"paragraph\",\"attrs\":{\"blockId\":\"$ID1\"},\"content\":[{\"type\":\"text\",\"text\":\"first paragraph\"}]},
  {\"type\":\"paragraph\",\"attrs\":{\"blockId\":\"$ID2\"},\"content\":[{\"type\":\"text\",\"text\":\"second paragraph, edited\"}]}]}"
api -X PATCH "$B/api/pages/$PAGE" -d "{\"content\":$EDITED}" > /dev/null
ok "PATCH with one edited paragraph"

DELTA=$(api "$B/api/pages/$PAGE/delta?since=1")
echo "$DELTA" | jqv "d['rev']" | grep -q "^2$" || fail "rev did not advance"
CHANGED=$(echo "$DELTA" | jqv "[b['block_id'] for b in d['blocks']]")
[ "$CHANGED" = "['$ID2']" ] || fail "delta reported $CHANGED, expected only $ID2"
ok "delta since=1 names exactly the edited block"
echo "$DELTA" | jqv "len(d['order'])" | grep -q "^3$" || fail "delta order incomplete"
echo "$DELTA" | jqv "d['deleted']" | grep -q "\[\]" || fail "unexpected deletions"
ok "delta carries the full block order and no deletions"

api "$B/api/pages/$PAGE/delta?since=2" | jqv "len(d['blocks'])" | grep -q "^0$" || fail "up-to-date client got work"
ok "delta since=2 is empty for an up-to-date client"

api "$B/api/pages/$PAGE/delta?since=999" | jqv "d['full']" | grep -q True || fail "future rev not rejected"
ok "delta from an impossible revision asks for a full refetch"

# ---- deleting a block ----
DELETED="{\"type\":\"doc\",\"content\":[
  {\"type\":\"heading\",\"attrs\":{\"level\":1,\"blockId\":\"$ID0\"},\"content\":[{\"type\":\"text\",\"text\":\"Alpha\"}]},
  {\"type\":\"paragraph\",\"attrs\":{\"blockId\":\"$ID2\"},\"content\":[{\"type\":\"text\",\"text\":\"second paragraph, edited\"}]}]}"
api -X PATCH "$B/api/pages/$PAGE" -d "{\"content\":$DELETED}" > /dev/null
api "$B/api/pages/$PAGE/delta?since=2" | jqv "d['deleted']" | grep -q "$ID1" || fail "deletion not reported"
ok "delta reports a deleted block by id"

# ---- a rename must not move rev ----
RB=$(api "$B/api/pages/$PAGE/blocks" | jqv "d['rev']")
api -X PATCH "$B/api/pages/$PAGE" -d '{"title":"Blocks renamed"}' > /dev/null
RA=$(api "$B/api/pages/$PAGE/blocks" | jqv "d['rev']")
[ "$RB" = "$RA" ] || fail "a rename bumped rev from $RB to $RA"
ok "renaming the page leaves rev at $RA"

# ---- full-text search still works through the projection ----
api "$B/api/search?q=edited" | jqv "len(d['results'])" | grep -qv "^0$" || fail "search found nothing"
ok "full-text search still finds the edited text"

# ---- versions still restore ----
VER=$(api "$B/api/pages/$PAGE/versions" | jqv "len(d['versions'])")
[ "$VER" != "0" ] || fail "no versions were snapshotted"
VID=$(api "$B/api/pages/$PAGE/versions" | jqv "d['versions'][-1]['id']")
api -X POST "$B/api/pages/$PAGE/versions/$VID/restore" > /dev/null
RESTORED=$(api "$B/api/pages/$PAGE/blocks" | jqv "len(d['blocks'])")
[ "$RESTORED" = "3" ] || fail "restore produced $RESTORED blocks, expected 3"
ok "restoring the first version brings all 3 blocks back"
api "$B/api/pages/$PAGE/blocks" | jqv "[b['block_id'] for b in d['blocks']]" | grep -q "$ID1" || fail "restored block lost its id"
ok "the restored block kept its original id"

# ---- the tree: creation order, then drag-and-drop ----
mk() { api -X POST "$B/api/pages" -d "{\"spaceId\":\"$SPACE\",\"title\":\"$1\"}" | jqv "d['page']['id']"; }
P1=$(mk one); P2=$(mk two); P3=$(mk three)
order() { api "$B/api/spaces/$SPACE/pages" | jqv "[p['title'] for p in d['pages']]"; }
BEFORE=$(order)
echo "$BEFORE" | grep -q "'one', 'two', 'three'" || fail "creation order wrong: $BEFORE"
ok "new pages append in creation order: $BEFORE"

# A drag: move 'three' to the top of the list.
api -X POST "$B/api/pages/$P3/move" -d '{"parentId":null,"index":0}' > /dev/null
order | grep -q "^\['three'" || fail "drag to top failed: $(order)"
ok "dragging a page to the top reorders the tree: $(order)"

# Two hundred drops into the same slot — the case that broke float positions.
for i in $(seq 1 60); do
  api -X POST "$B/api/pages/$P2/move" -d '{"parentId":null,"index":1}' > /dev/null
  api -X POST "$B/api/pages/$P1/move" -d '{"parentId":null,"index":1}' > /dev/null
done
DUP=$(api "$B/api/spaces/$SPACE/pages" | jqv "len(d['pages']) - len(set(p['order_key'] for p in d['pages']))")
[ "$DUP" = "0" ] || fail "$DUP pages collided on an order key"
ok "120 repeated drops into the same slot: no order-key collisions"

# Nesting, which the drag also does.
api -X POST "$B/api/pages/$P1/move" -d "{\"parentId\":\"$P3\",\"index\":0}" > /dev/null
api "$B/api/spaces/$SPACE/pages" | jqv "[p['title'] for p in d['pages'] if p['parent_id']]" | grep -q "one" || fail "nesting failed"
ok "dragging a page onto another nests it"

# The MCP server's numeric `position` argument still lands where it says.
api -X POST "$B/api/pages/$P2/move" -d '{"parentId":null,"position":0}' > /dev/null
order | grep -q "^\['two'" || fail "MCP-style position move failed: $(order)"
ok "the MCP server's numeric position argument still works: $(order)"

# ---- depth (issue #24) ----
#
# The routes, not the library. server/test/integration/depth.mjs already covers
# movePage and the depth arithmetic directly; what is only reachable over HTTP is
# whether POST /api/pages, the bulk move and link-search agree with it. Each of
# these was a hard "one level deep" refusal before this issue.
#
# `api` asserts a 2xx, so a call that must be *refused* goes through `refused`,
# which asserts the status and returns the message for the caller to check.
refused() {
  local body status
  body=$(curl -s -w '\n%{http_code}' -b "$J" -c "$J" -H 'Content-Type: application/json' "$@")
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  case "$status" in
    400) printf '%s' "$body" ;;
    *) printf '  FAIL expected HTTP 400, got %s from %s\n     %s\n' "$status" "$*" "$body" >&2; exit 1 ;;
  esac
}

# A chain built through the API one subpage at a time. Under the old cap the
# third call here was the one that 400'd.
sub() { api -X POST "$B/api/pages" -d "{\"spaceId\":\"$SPACE\",\"parentId\":\"$1\",\"title\":\"$2\"}" | jqv "d['page']['id']"; }
D1=$(mk depth-1)
D2=$(sub "$D1" depth-2); D3=$(sub "$D2" depth-3); D4=$(sub "$D3" depth-4)
D5=$(sub "$D4" depth-5); D6=$(sub "$D5" depth-6)
CRUMBS=$(api "$B/api/pages/$D6" | jqv "[b['title'] for b in d['breadcrumbs']]")
[ "$CRUMBS" = "['depth-1', 'depth-2', 'depth-3', 'depth-4', 'depth-5']" ] \
  || fail "breadcrumbs at depth 6 wrong: $CRUMBS"
ok "POST /api/pages nests six levels deep and breadcrumbs walk all of them"

SUB=$(api "$B/api/pages/$D1/subtree" | jqv "[p['title'] for p in d['pages']]")
[ "$SUB" = "['depth-1', 'depth-2', 'depth-3', 'depth-4', 'depth-5', 'depth-6']" ] \
  || fail "subtree at depth 6 wrong: $SUB"
ok "GET /pages/:id/subtree returns all six levels in document order"

# Down to the limit, then one past it. The chain above is 6 long, so 14 more
# calls put a page at level 20 — the deepest a page is allowed to be.
TAIL=$D6
for i in $(seq 7 20); do TAIL=$(sub "$TAIL" "depth-$i"); done
MSG=$(refused -X POST "$B/api/pages" -d "{\"spaceId\":\"$SPACE\",\"parentId\":\"$TAIL\",\"title\":\"too deep\"}")
echo "$MSG" | grep -q "20 levels deep" || fail "create past the limit gave the wrong error: $MSG"
ok "creating a 21st level is refused with the limit named"

# The same limit on a move, and on the bulk move, so no route is a way around it.
STRAY=$(mk stray)
MSG=$(refused -X POST "$B/api/pages/$STRAY/move" -d "{\"parentId\":\"$TAIL\"}")
echo "$MSG" | grep -q "20 levels deep" || fail "move past the limit gave the wrong error: $MSG"
MSG=$(refused -X POST "$B/api/pages/move-many" -d "{\"pageIds\":[\"$STRAY\"],\"parentId\":\"$TAIL\"}")
echo "$MSG" | grep -q "20 levels deep" || fail "bulk move past the limit gave the wrong error: $MSG"
ok "the move and bulk-move routes enforce the same limit"

# A branch carrying subpages becoming a subpage — flatly refused before this
# issue, regardless of how much room there was.
B1=$(mk branch-1); B2=$(sub "$B1" branch-2); B3=$(sub "$B2" branch-3)
api -X POST "$B/api/pages/move-many" -d "{\"pageIds\":[\"$B1\"],\"parentId\":\"$D3\"}" > /dev/null
LVL=$(api "$B/api/pages/$B3" | jqv "len(d['breadcrumbs']) + 1")
[ "$LVL" = "6" ] || fail "the moved branch landed at level $LVL, expected 6"
ok "a three-deep branch bulk-moves under a level-3 page and keeps its shape"

# A page must still not be moved into its own descendant, at any depth.
MSG=$(refused -X POST "$B/api/pages/$B1/move" -d "{\"parentId\":\"$B3\"}")
echo "$MSG" | grep -q "inside itself" || fail "cycle refusal gave the wrong error: $MSG"
ok "moving a page under its own grandchild is still refused"

# link-search takes a list of exclusions now, which is how the parent picker
# keeps the moved page's own descendants out of the menu.
HITS=$(api "$B/api/pages/link-search?q=branch&spaceId=$SPACE&onlySpace=1&exclude=$B1&exclude=$B2" \
  | jqv "sorted(p['title'] for p in d['pages'])")
[ "$HITS" = "['branch-3']" ] || fail "multi-exclude link-search returned: $HITS"
ok "link-search excludes every id it is given, not just the first"

# Restore brings back the branch that went to the trash with the page, not just
# the row that was clicked.
api -X DELETE "$B/api/pages/$B1" > /dev/null
COUNT=$(api -X POST "$B/api/pages/$B1/restore" | jqv "d['restored']")
[ "$COUNT" = "3" ] || fail "restore brought back $COUNT pages, expected 3"
SUB=$(api "$B/api/pages/$B1/subtree" | jqv "[p['title'] for p in d['pages']]")
[ "$SUB" = "['branch-1', 'branch-2', 'branch-3']" ] || fail "restored subtree is $SUB"
ok "restoring a trashed branch brings back all three of its levels"

echo
echo "API end-to-end passed"
