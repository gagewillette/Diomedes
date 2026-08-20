# Block storage

How a Diomedes page is stored, why a paragraph now has a name, and what that
buys.

---

## 1. The problem

A page body used to be one opaque `content jsonb` column. That is a perfectly
good way to store a document and a very bad way to *talk* about one, because the
only handle it offers is a position in an array — and that position shifts
whenever anything above it changes.

Every consequence of that traces back to the same missing primitive:

- **Search re-embedded whole pages.** `page_chunks` is keyed by `chunk_index`,
  which moves when anything above it moves, so there was nothing stable to diff
  against. Fixing one typo on a forty-chunk page cost forty embedding API calls.
- **A cache could only be page-granular.** "What changed?" had no answer smaller
  than "the document".
- **Ordering could not be expressed at all** inside a body, and the tree's
  ordering was expressed with a float that runs out of precision (§4).

## 2. Block identity

Every block-level node carries a `blockId` attribute:

```
blk_01M0EKHQJSRYYQ8SZ1DQCG
    └── ULID-shaped: base-32 timestamp, then randomness
```

It is minted **client-side**, in `client/src/editor/blockId.js`. It has to be:
a server-assigned id would need a round trip per keystroke and would have nothing
to attach itself to when the round trip came back. Ids sort by creation time and
collide with probability that rounds to zero.

Documents that arrive without ids — from the REST API, the MCP server, a
markdown import — are stamped server-side instead, and **the stamped document is
what gets stored**. That write-back is load-bearing: without it every save would
mint fresh ids, every block would look new, and the whole scheme would collapse
back into whole-page rewrites.

### Paste

One rule covers both halves of the paste story: a block whose id duplicates an
earlier one in the same document is renamed.

- **Copy/paste** — ProseMirror serialises a copy with its attributes intact, so
  the pasted block arrives holding an id that is already taken. It collides and
  is renamed, and a page never holds a duplicate.
- **Cut/paste** — the original is gone, nothing collides, and the block keeps its
  identity across the move. This is what stops a drag from reading as a delete
  plus an unrelated insert to the embedding queue.

Cross-document paste keeps the incoming ids, which is harmless: an id only has to
be unique within its page.

## 3. The projection

```
                    ┌─────────────────────────────────┐
   browsers ───────▶│  Yjs CRDT  (page_ydoc)          │  source of truth
                    │  live while the page is open    │  while editing
                    └───────────────┬─────────────────┘
                                    │ one elected client
                                    │ snapshots the JSON
                                    ▼
                    ┌─────────────────────────────────┐
   MCP / API ──────▶│  PATCH /api/pages/:id           │
                    └───────────────┬─────────────────┘
                                    │  writePageBody(), one transaction
                    ┌───────────────┴─────────────────┐
                    ▼                                 ▼
             pages.content                       page_blocks
          (+ text_content, tsv)              (+ tombstones, rev)
           the stored document              the derived projection
```

`page_blocks` holds one row per top-level block and is **derived from the
document**, inside the same transaction that stores it. It is written by nothing
except `server/src/lib/blocks.js`, so it is always exactly consistent with the
`pages.content` committed beside it.

### Why this direction

The original migration plan had it the other way round: `page_blocks`
authoritative, `pages.content` rebuilt from it. That was written before realtime
collaboration landed and no longer holds.

Since the CRDT arrived, the live source of truth for an open page is the Yjs
document. Making `page_blocks` authoritative would put a second writer —
last-write-wins, over whole blocks — in competition with something that already
merges correctly at character level, and the worse of the two would win every
disagreement.

For the same reason there is no `POST /pages/:id/ops`. Its purpose was to end
whole-document clobbering; the CRDT already ended it. An ops endpoint now would
be a second, weaker write path rather than a correctness win.

The legacy whole-body `PATCH` therefore stays exactly as it was from the caller's
side and is converted internally into a block diff. A client that resends an
entire unchanged document costs one hash comparison per block and zero writes.

### Revisions

`pages.rev` increments once per body write. Each block row carries the page rev
**at the last change to that block** — so a save that edited one paragraph leaves
the other thirty-nine rows at the revision they were last genuinely edited at.
That is the signal both the delta endpoint and the embedding queue read.

A metadata-only write — a rename, an emoji — does not bump `rev` at all.

### Deletions

A client holding revision N cannot learn about a deleted block from
`page_blocks`, because the evidence is a row that is *not there*, and absence is
not something `WHERE rev > N` can return. `page_block_tombstones` records them.

A client further behind than the tombstone horizon is told `full: true`
explicitly rather than handed a quietly incomplete delta. The failure being
avoided is a client rendering a block nobody else can see, with nothing that
would ever correct it.

## 4. Order keys

Ordering — of blocks within a page, and of pages within the tree — uses a
base-62 fractional index (`server/src/lib/orderKey.js`), not the
`position double precision` it replaces.

A double looks like a fractional index but is not one. Its 52-bit mantissa runs
out of representable midpoints after roughly fifty inserts into the same gap, and
the next one lands *on top of* its neighbour. The old code carried a
`needsRenumber` flag and a whole-list respread to recover from that; a string
index simply grows a character instead, so a drop is always one row.

This mattered immediately: drag-and-drop page moves shipped onto the float
encoding, so every drop into an already-tight gap was one step closer to two
pages sharing a position and the sibling order becoming undefined.

> **`COLLATE "C"` is load-bearing.** The encoding depends on comparisons matching
> ASCII order. A default `en_US.UTF-8` collation sorts case-insensitively,
> placing `a` between `A` and `B` — which scrambles the ordering with no error
> anywhere. Both order-key columns are declared `text COLLATE "C"`, and
> `test/integration/blocks.mjs` asserts the database really sorts that way rather
> than merely claiming to.

Order keys are scoped to a sibling list, so two pages under different parents
sharing the key `a0` is normal and correct.

### Reordering blocks

The drag handle (`client/src/editor/blockDrag.js`) writes no order key at all.
It puts the block under the pointer into a ProseMirror `NodeSelection` and hands
the editor a `move: true` drag; the drop applies one transaction that deletes
the block and reinserts it, so the block keeps its id and the page saves through
the same `PATCH` as any other edit.

Everything about ordering then happens server-side, in `assignOrderKeys`. It
keeps the **longest increasing subsequence** of the stored keys and mints new
ones only for the blocks between them:

```
stored   a0   a1   a2   a3   …  a9        (ten blocks)
dragged  a9   a0   a1   a2   …  a8        (the last one moved to the top)
                └── kept: nine keys already in the right order
         └────── rewritten: one key, `generateKeyBetween(null, 'a0')`
```

Keeping keys greedily from the left instead would keep `a9` — the one block that
did move — and rewrite the other nine, and since a rewritten row takes the new
page `rev`, a reorder that changed no text would report nine changed blocks to
`/delta` and hand the embedding queue nine blocks to re-embed. The subsequence
is what makes a one-block drag cost one row, which is the promise the encoding
was chosen for.

Alt+Shift+↑/↓ moves the block holding the cursor and goes through exactly the
same path — the handle is one way to produce a reordered document, not a second
write path.

## 5. Block-scoped embedding

`page_chunks.source_block_ids` records which blocks each chunk was built from.

The chunker deliberately does *not* emit one chunk per block — it packs blocks up
to `MAX_CHUNK_TOKENS` and carries `OVERLAP_TOKENS` across boundaries, which is
good retrieval design worth preserving. So a chunk spans several blocks and
neighbours share text. Two consequences are handled explicitly:

- a **heading** is recorded as a source of every chunk in its section, because it
  contributes its text to all of them through the trail prefix — so editing a
  heading re-embeds its section automatically rather than by special case;
- the **overlap tail** carries text from one chunk into the next, so the block it
  came from is a source of both.

A chunk is recomputed if it is new text, or if it draws on a block the save
changed. Otherwise its stored vector is carried across.

Reuse is keyed on the chunk's **exact content**, not its index, and that choice
does real work:

- inserting a paragraph at the top shifts every index below it while changing
  none of their text — index-keyed reuse would re-embed the page;
- a chunk that borrowed an overlap tail from an edited block has different
  content, so it is recomputed rather than left subtly stale;
- renaming a page rewrites the title prefix of every chunk, so nothing is
  reusable and the page is fully re-embedded — falling out of the same rule
  rather than needing to be detected.

**A typo fix on a forty-chunk page: 40 embedding calls → 1–2.**

Jobs carry the changed set through `notePageChanged(pageId, updatedAt, blockIds)`.
Three states, each meaning something different:

| `blockIds` | Meaning |
|---|---|
| a list | re-embed only what those blocks reach |
| `[]` | nothing in the body changed — no job is enqueued |
| absent | provenance unknown (backfill, trash restore) — rebuild the page, as before |

That last row is what keeps `backfill.js` and any pre-migration document working:
a document with no block ids contributes no sources, so it never qualifies for
incremental treatment and is simply rebuilt.

## 6. Testing

```bash
cd server
npm test                 # unit; no database required

# integration; needs postgres and a throwaway database
DATABASE_URL=…  npm run test:integration

# the HTTP surface, against a running server
DATABASE_URL=… PORT=3111 node src/index.js &
BASE_URL=http://localhost:3111 test/integration/api.sh
```

`test/integration/upgrade.mjs` builds the previous schema by running
`origin/main`'s own `db.js`, rather than a hand-written approximation that could
drift, then asserts every sibling list survives the float-to-order-key migration
in the same order.

## 7. Pages written before this migration

They have no rows in `page_blocks` until they are next saved, and **there is no
backfill**. That is a deliberate choice, not an omission.

Nothing reads the projection yet — `/blocks` and `/delta` are substrate for a
cache that is not built. Reading, editing, full-text search and semantic search
all go through `pages.content` exactly as before, so an unprojected page has no
symptom. The first ordinary save projects it, mints its ids and writes them back.
Markdown import and every other way of *creating* a page is unaffected: those go
through `writePageBody` and are block-structured from the moment they exist.

Semantic search stays correct across that boundary for free. Chunks written
before the migration carry an empty `source_block_ids`, and chunk reuse is keyed
on content rather than block attribution — so on that first save, the chunks
whose text did not change are still reused.

The natural moment to add a backfill is when the cache lands and starts depending
on the projection. By then most active pages will have converted themselves. It
would be a loop over pages with `rev = 0` calling `writePageBody`, leaving
`updated_at`/`updated_by` alone so it does not push every page to the top of
"recently updated".

## 8. What this does not deliver

- **No character-level merge from blocks.** That is the CRDT's job, and it
  already does it. `blockId` is the designed join point if the CRDT is ever
  restructured as a `Y.Array` of `Y.Map` blocks.
- **No client-side cache yet.** `GET /pages/:id/delta` is the substrate for one;
  the IndexedDB mirror that would consume it is not built.
- **No block-level permissions.** Authorisation is per space, as before.
