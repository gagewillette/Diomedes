# Realtime collaboration

How Diomedes lets several people edit the same page at once, why it is built the
way it is, and which races it had to close along the way.

---

## 1. How Google Docs does it

Google Docs uses **operational transformation** (OT), in the star-topology form
described by the Jupiter system (Nichols et al., 1995). Every client talks only
to the server; clients never talk to each other.

The mechanism, from the client's side:

- The client tracks the **server revision number** it last saw, plus two local
  queues: the edit it has **sent but not had acknowledged**, and everything typed
  **since** that send.
- It keeps at most **one edit in flight**. The pending keystrokes accumulate into
  a bundle that is sent as one operation the moment the previous acknowledgement
  arrives. This is what makes each client's contribution a single linear stream,
  and it is why a Docs session feels "chunky" on a slow connection rather than
  incoherent.
- Every operation is stamped with the revision it was composed against.

And from the server's side:

- The server owns the single authoritative revision log. When an operation
  arrives based on revision *N* while the server is at revision *M*, it
  **transforms** that operation against each of the *M − N* operations committed
  in between, applies the result, increments the revision, and broadcasts the
  transformed form to everyone else.
- Because ordering is decided in one place, the transform only has to satisfy
  **TP1** — transforming a concurrent pair in either order converges. The much
  harder **TP2** property, which peer-to-peer OT needs, never comes up. That
  simplification is the whole reason the star topology was chosen.

Clients receiving a broadcast transform it against their own outstanding
operations before applying it, and transform those outstanding operations against
the incoming one, so the local and server views stay reconcilable.

Everything else follows from that spine:

- **Reconnection** is a revision-number question: "give me everything after *N*",
  or a fresh snapshot when the gap is too large. Because operations are
  transformed rather than merged blindly, replaying a missed window is safe.
- **Undo** is per-user: the inverse of your own operation, transformed against
  everything committed since, so undo never reverts a colleague's paragraph.
- **Persistence** is a periodic model snapshot plus the mutation log after it,
  rather than a document rewrite per keystroke.
- **Presence and cursors** ride a *separate, lossy* channel. Cursor positions are
  ephemeral: dropping one costs nothing, so they are never allowed to hold up the
  edit stream.

The race conditions OT has to answer are: two edits at the same position
(resolved by the server's arbitrary but total order, then transformed for
everyone else); an edit composed against a stale revision (transformed forward);
and duplicate or out-of-order delivery (excluded by revision numbers and the
single in-flight rule).

## 2. What Diomedes does instead, and why

Diomedes uses a **CRDT** (Yjs, whose sequence algorithm is YATA) rather than OT.

The deciding factor is where the document schema lives. An OT server must
understand the operations it transforms — for a rich text editor that means the
server needs the full ProseMirror schema, every custom node type (callouts,
Mermaid diagrams, Excalidraw boards, page links), and a transform function kept
in lockstep with them. Diomedes' schema lives entirely in the client's TipTap
extension list. Reproducing it server-side would double every future editor
change.

A CRDT inverts that. Concurrent operations **commute**: every character carries a
unique `(clientId, clock)` identity, and concurrent insertions at the same
position are given a deterministic total order that every replica computes
independently. The server never has to interpret an edit — it only has to
deliver bytes. Duplicated or reordered delivery is harmless, because applying the
same update twice is a no-op.

That property is what makes the rest of the design possible:

- The relay needs no ordering guarantees, so updates can be mirrored between app
  processes over Redis pub/sub without sequence numbers or replay logic.
- Persistence is a single opaque blob (`page_ydoc.state`), not a revision log
  that has to be compacted.
- The server can enforce permissions without understanding content: it either
  forwards an update or drops it.

The cost is metadata — deleted characters leave tombstones, so a heavily edited
document's CRDT state is larger than its text. For wiki pages that is a good
trade.

## 3. The pieces

```
browser                                   server
───────                                   ──────
Y.Doc  ──┬─ TipTap Collaboration          ws /api/collab/<pageId>
         └─ CollaborationCursor            │
                                           ├─ session-cookie auth + space role
y-websocket provider ─── ws ───────────────┤
         │                                 ├─ Room (Y.Doc + Awareness)
         ├─ sync protocol (doc updates)    │   ├─ fan-out to local sockets
         └─ awareness (presence)           │   ├─ Redis pub/sub to other processes
                                           │   └─ debounced flush → page_ydoc
elected client ── PATCH /api/pages/:id ────┴─ pages.content (search, history, export)
```

- `server/src/collab/` — the websocket endpoint, the room registry, the Redis
  bridge, and postgres persistence.
- `client/src/editor/collab/` — the provider session, presence, the remote caret
  and pointer rendering, seeding and snapshotting.
- `client/src/lib/userColor.js` — presence colours.

**Authentication** happens during the HTTP upgrade. A browser cannot attach an
`Authorization` header to a websocket handshake, so the express session
middleware is run against the raw upgrade request and the space role is checked
before the socket is accepted. Rejections use close codes in the 4400–4499 range,
which the client treats as permanent and stops retrying.

**Read-only users** connect, receive updates, and broadcast presence — but every
inbound message is re-checked server side, and any sync message that would mutate
the document is dropped. A client that is told it is a reader is never trusted to
enforce that itself.

## 4. Cursors and pointers

Presence rides Yjs *awareness*, the lossy sibling of the document channel: state
is per-connection, expires on disconnect, and is never persisted.

Each participant publishes a mode, and what everyone else renders depends on it:

| mode | when | what other people see |
| --- | --- | --- |
| `typing` | a local edit landed in the last 1.4s | their **text caret**, with the name label attached |
| `pointing` | reading, scrolling, selecting, idle | their **mouse pointer**, Miro-style, with the name attached |

Selection highlights are drawn in both modes — watching someone sweep a selection
is exactly the "busy but not typing" case, and the highlight is what makes it
legible. What moves between the two modes is the *name label*, so a document with
five people in it never accumulates five permanent badges over the text.

Pointer positions are published in **content coordinates** — x as a fraction of
the editor's width, y in pixels from the top of the document — not viewport
coordinates. Two people with different window sizes, scrolled to different
places, still see each other's pointer against the same paragraph. Positions are
recomputed on scroll as well as on mouse movement, because scrolling moves the
document under a stationary mouse. Updates are throttled to ~20/s and the
receiving side smooths them with a short CSS transition.

**Colours** are derived from the user id (FNV-1a hash into a fixed palette), so
every browser paints the same person the same colour with no coordination, and
the colour survives reconnects and restarts. The palette is deliberately narrow:
every entry is a saturated, mid-luminance hue — nothing white, black, grey or
dark, so a cursor is never mistaken for text or the native caret.
`server/test/userColor.test.js` enforces those bounds rather than leaving them to
review.

## 5. The races, and how each is closed

**First-open seeding.** A page created before this feature existed has its content
in `pages.content` and nothing in the CRDT. Converting the JSON into the CRDT is
an ordinary insert as far as Yjs is concerned — so if two browsers open a fresh
page at the same instant and both convert, both inserts are valid and the
document ends up containing the page *twice*. The CRDT cannot detect that,
because nothing about the two edits says they mean the same thing.

The right to seed is therefore arbitrated by a single conditional `UPDATE`
(`POST /api/pages/:id/collab/claim-seed`). Postgres row locking picks the winner;
everyone else waits for the resulting update to sync to them normally. The claim
is a **lease**, not a flag: a client that wins it and then dies would otherwise
strand the page at an empty document forever, so the claim expires after 15
seconds and the next client retries — including the one that was refused, which
looks again once the lease it lost to has run out. A `NOT EXISTS` guard against
`page_ydoc` closes the other end: once any CRDT state has been persisted, seeding
can never fire again — without it, deleting every word on a page would make it
look unseeded and resurrect the old text.

That guard is also the *only* thing that ends seeding. There is a confirm call,
and a `collab_seeded` flag it sets, but neither gates the claim: they record what
a client said it did, and a client can say it and be gone before the text ever
left the browser. Gating on the flag gave the page a terminal state — marked
seeded, CRDT empty, blank for everyone forever — which is exactly what a batch
import used to walk into. Asking for the persisted document instead means an
unfinished seed simply expires and is picked up by whoever opens the page next.

**Snapshot writes.** `pages.content` still backs search, version history, markdown
export, the public share view and the REST API. If every client wrote it back,
every edit would produce N identical `PATCH`es and N version-history entries. The
writer with the **lowest Yjs client id among connected writers** does it. Every
client computes the same answer from the same awareness data, so the role
transfers by itself when that person leaves — no election protocol, and no window
where nobody is saving.

**Messages arriving before the room is ready.** Opening a room hits the database,
but the client begins its sync handshake the instant the socket opens. Messages
that arrive during that window are queued and replayed once the room resolves.
Dropping a client's sync step 1 leaves it waiting forever for a step 2 that is
never sent — this was a real bug, caught by the integration test.

**Two app processes, one page.** Each room subscribes to a per-page Redis channel
and republishes its local updates there. Every message carries the originating
process id, so a publisher ignores its own echo. Yjs' idempotence is what makes
this safe with no ordering or delivery guarantees at all.

**Eviction while a write is in flight.** Flushes are serialised on a per-room
promise chain, and a room is only destroyed after its final flush resolves.

**Version restore.** Restoring replaces the document wholesale, which a CRDT
cannot express as an edit. The stored doc and the seed flag are cleared, every
connected client is disconnected with a transient close code, and the *client*
also rebuilds its `Y.Doc` from scratch — reconnecting with the old document would
push the discarded content straight back into the empty room.

## 6. Durability

Two layers, deliberately different in cost:

- **The CRDT** (`page_ydoc`) is flushed on a 2s debounce, force-flushed after 10s
  of continuous editing, and again when the last client leaves. This is the copy
  that survives a hard tab close with no loss.
- **The JSON snapshot** (`pages.content`) is derived, written on a 2.5s debounce
  by the elected client, and immediately when it navigates away. A hard browser
  crash can leave it a few seconds stale — which affects the search index and
  exports until the next edit, never the editor itself, since reopening the page
  loads the CRDT.

## 7. Testing

`server/test/collab.test.js` runs the real stack — express, `ws`, postgres, redis
— and drives two websocket clients through it:

- concurrent inserts at the same position converge to the same string on both;
- presence and pointer positions propagate;
- the document survives every client leaving and is restored to a fresh client;
- an unauthenticated upgrade is refused;
- a reader's edit is dropped while their presence still gets through.

It skips itself when there is no database. To run it against a scratch database:

```bash
docker exec diomedes-dev-db psql -U diomedes -d postgres -c "CREATE DATABASE diomedes_collabtest;"
cd server
COLLAB_TEST_DATABASE_URL="postgres://diomedes:dev@localhost:5432/diomedes_collabtest" npm test
```
