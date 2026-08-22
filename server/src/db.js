import pg from 'pg';
import { EMBED_DIMS } from './search/config.js';
import { generateNKeysBetween } from './lib/orderKey.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '📚',
  public_role text CHECK (public_role IS NULL OR public_role IN ('reader','writer')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'reader' CHECK (role IN ('admin','writer','reader')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES pages(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  content jsonb NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
  text_content text NOT NULL DEFAULT '',
  -- Where this page sits among its siblings. A base-62 fractional index, not
  -- the double precision it replaces: a double's 52-bit mantissa runs out of
  -- midpoints after ~50 drops into the same gap and the next one silently
  -- lands on top of its neighbour. See server/src/lib/orderKey.js.
  --
  -- COLLATE "C" is load-bearing, not decoration. The encoding depends on
  -- comparisons matching ASCII order; a default en_US.UTF-8 collation sorts
  -- case-insensitively, putting 'a' between 'A' and 'B', which scrambles the
  -- ordering with no error anywhere.
  order_key text COLLATE "C" NOT NULL DEFAULT 'a0',
  -- Monotonic revision, bumped once per write to the body. The handle every
  -- incremental consumer needs: ?since=rev for the cache, and a per-block
  -- copy in page_blocks so a save that changed one paragraph leaves the other
  -- thirty-nine rows at the revision they were last genuinely edited at.
  rev bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  share_token text UNIQUE,
  tsv tsvector
);
CREATE INDEX IF NOT EXISTS pages_space_idx ON pages (space_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pages_tsv_idx ON pages USING gin (tsv);
CREATE INDEX IF NOT EXISTS pages_updated_idx ON pages (updated_at DESC) WHERE deleted_at IS NULL;
-- pages_sibling_order_idx is created in migrate(), not here. On an existing
-- deployment this block runs before the ALTER that adds order_key, and
-- CREATE INDEX IF NOT EXISTS still fails on a column that does not exist yet.

-- One row per top-level block of a page, projected from pages.content inside
-- the same transaction that stores it. See server/src/lib/blocks.js for why
-- this is a projection rather than the source of truth (short version: since
-- realtime collaboration landed, the Yjs CRDT is the source of truth for an
-- open page, and a second last-write-wins writer competing with it would be a
-- regression).
CREATE TABLE IF NOT EXISTS page_blocks (
  page_id      uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id     text NOT NULL,
  type         text NOT NULL,
  content      jsonb NOT NULL,
  text_content text NOT NULL DEFAULT '',
  order_key    text COLLATE "C" NOT NULL,   -- see the note on pages.order_key
  hash         text NOT NULL,               -- of the canonicalised block JSON
  rev          bigint NOT NULL,             -- page rev at the last change to THIS block
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, block_id)
);
CREATE INDEX IF NOT EXISTS page_blocks_order_idx ON page_blocks (page_id, order_key);
-- Serves the delta endpoint: "every block of this page above revision N".
CREATE INDEX IF NOT EXISTS page_blocks_rev_idx ON page_blocks (page_id, rev);

-- Tombstones for blocks that have been deleted.
--
-- A cache holding revision N cannot learn about a deletion from page_blocks,
-- because the evidence is the absence of a row — and absence is not something
-- a WHERE rev > N query can return. Without this, a client that missed the
-- write would keep rendering a block nobody else can see, and the only repair
-- would be refetching whole documents, which is the cost the delta exists to
-- avoid. Rows are garbage-collected once no cache could still be that far
-- behind; see BLOCK_TOMBSTONE_TTL_DAYS in routes/pages.js.
CREATE TABLE IF NOT EXISTS page_block_tombstones (
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id   text NOT NULL,
  rev        bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, block_id)
);
CREATE INDEX IF NOT EXISTS page_block_tombstones_rev_idx ON page_block_tombstones (page_id, rev);
CREATE INDEX IF NOT EXISTS page_block_tombstones_gc_idx ON page_block_tombstones (deleted_at);

CREATE TABLE IF NOT EXISTS page_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  content jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_versions_page_idx ON page_versions (page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  content text NOT NULL,
  -- Null for a comment about the whole page; {blockId, quote, offset, prefix,
  -- suffix} for one about a phrase in it. Re-resolved against the live document
  -- on every read — see client/src/lib/commentAnchor.js.
  anchor jsonb,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_page_idx ON comments (page_id, created_at);

CREATE TABLE IF NOT EXISTS favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS page_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_id uuid REFERENCES pages(id) ON DELETE CASCADE,
  target_title text NOT NULL DEFAULT '',
  by_id boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_links_source_idx ON page_links (source_id);
CREATE INDEX IF NOT EXISTS page_links_target_idx ON page_links (target_id);
CREATE INDEX IF NOT EXISTS page_links_title_idx ON page_links
  (lower(regexp_replace(btrim(target_title), '\s+', ' ', 'g'))) WHERE target_id IS NULL;

CREATE TABLE IF NOT EXISTS perf_samples (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('client','server')),
  kind text NOT NULL,
  name text NOT NULL DEFAULT '',
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  duration_ms double precision NOT NULL DEFAULT 0,
  server_ms double precision,
  transfer_bytes bigint NOT NULL DEFAULT 0,
  encoded_bytes bigint NOT NULL DEFAULT 0,
  decoded_bytes bigint NOT NULL DEFAULT 0,
  status int,
  count int NOT NULL DEFAULT 1,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS perf_samples_ts_idx ON perf_samples (ts DESC);
CREATE INDEX IF NOT EXISTS perf_samples_kind_idx ON perf_samples (source, kind, ts DESC);
CREATE INDEX IF NOT EXISTS perf_samples_name_idx ON perf_samples (kind, name, ts DESC);

-- A revocable, per-space credential that lets another Diomedes workspace pull a
-- frozen slice of this space over the network.
--
-- The selection is stored here rather than recomputed at pull time on purpose.
-- A key is a promise about *what* was shared, and the person who minted it is
-- not around when it is redeemed: if the query re-ran, a page created under an
-- exported parent next week would silently join an export nobody re-approved,
-- and a page moved out of the selection would vanish from an import that had
-- already been run once. Freezing the id list keeps the promise auditable —
-- what the modal showed is exactly what the other end can ever receive.
--
-- Only the sha256 of the secret is stored, like api_tokens: the plaintext is
-- shown once, at mint time, and cannot be recovered from a database dump.
-- `key_prefix` is the first few characters, kept so the management list can
-- name a key without being able to reconstruct it.
CREATE TABLE IF NOT EXISTS space_export_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text UNIQUE NOT NULL,
  key_prefix text NOT NULL,
  -- [{ id, includeContent }] in document order. includeContent false marks an
  -- ancestor carried along only to keep the tree shape intact.
  selection jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS space_export_keys_space_idx ON space_export_keys (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid REFERENCES pages(id) ON DELETE CASCADE,
  space_id uuid REFERENCES spaces(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime text NOT NULL DEFAULT 'application/octet-stream',
  size bigint NOT NULL DEFAULT 0,
  disk_path text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  content text NOT NULL,
  embedding vector(${EMBED_DIMS}),
  token_count int NOT NULL DEFAULT 0,
  -- Which blocks this chunk was built from. The chunker deliberately does not
  -- emit one chunk per block — it packs blocks up to MAX_CHUNK_TOKENS and
  -- carries OVERLAP_TOKENS across boundaries, which is good retrieval design
  -- worth keeping — so a chunk spans several blocks and neighbours share text.
  -- Recording the set is what lets a save re-embed only the chunks that
  -- intersect the blocks it changed, instead of deleting and rebuilding all of
  -- them. A one-word edit on a 40-chunk page goes from 40 embedding calls to
  -- one or two.
  source_block_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS page_chunks_page_idx ON page_chunks (page_id);
-- page_chunks_blocks_idx is created in migrate() for the same reason as
-- pages_sibling_order_idx: on an existing database the column it indexes does
-- not exist until the ALTER below has run.
CREATE INDEX IF NOT EXISTS page_chunks_embedding_idx ON page_chunks USING hnsw (embedding vector_cosine_ops);
`;

// Set by migrate(); semantic search stays off when the extension is missing so
// a plain postgres:16 image keeps working.
export let vectorAvailable = false;

/**
 * Move an existing page tree off `position double precision` onto `order_key`.
 *
 * The migration plan recommends wiping the document store instead of writing a
 * backfill, and that is the right call for this deployment. This one exists
 * anyway, and it is fifteen lines rather than the risky content-rewriting
 * backfill the plan was warning about: Diomedes is self-hosted by other people,
 * and for them the alternative is every page in every space collapsing to the
 * same default key — a tree that silently loses its order with no error to
 * explain it.
 *
 * It runs once. `position` is dropped afterwards, so the presence of the column
 * is itself the "not yet migrated" flag and a restarted server cannot run it a
 * second time and renumber a tree people have since rearranged.
 */
async function migrateTreeOrder() {
  const { rows: hasPosition } = await q(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'pages' AND column_name = 'position'`
  );
  if (!hasPosition.length) return;

  const { rows } = await q(
    `SELECT id, space_id, parent_id FROM pages
     ORDER BY space_id, parent_id NULLS FIRST, position, created_at`
  );
  if (rows.length) {
    // Sibling lists are numbered independently: an order key only ever has to
    // sort correctly against the pages it shares a parent with.
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.space_id}:${row.parent_id ?? ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.id);
    }
    for (const ids of groups.values()) {
      const keys = generateNKeysBetween(null, null, ids.length);
      for (let i = 0; i < ids.length; i++) {
        await q('UPDATE pages SET order_key = $1 WHERE id = $2', [keys[i], ids[i]]);
      }
    }
    console.log(`migrated ${rows.length} pages from float positions to order keys`);
  }
  await q('ALTER TABLE pages DROP COLUMN IF EXISTS position');
}

export async function migrate() {
  // Wait for postgres to accept connections (fresh compose stacks race the db).
  for (let attempt = 1; ; attempt++) {
    try {
      await q('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`waiting for database (${attempt})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await q(SCHEMA);
  // additive migrations for existing deployments
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'`);
  // Space-wide default access. NULL keeps the space private (membership only);
  // 'reader'/'writer' let every signed-in user in at that level unless they
  // have a space_members row, which always wins.
  await q(`ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_role text`);
  await q(`ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_public_role_check`);
  await q(`ALTER TABLE spaces ADD CONSTRAINT spaces_public_role_check
           CHECK (public_role IS NULL OR public_role IN ('reader','writer'))`);
  // Realtime collaboration: the encoded Yjs document is the live source of
  // truth while a page is open; pages.content stays as the queryable snapshot.
  await q(`
    CREATE TABLE IF NOT EXISTS page_ydoc (
      page_id uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      state bytea NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  // collab_seeded records that pages.content has been converted into the CRDT
  // exactly once; the claim timestamp is the lease that makes that conversion
  // safe when several clients open a page at the same instant.
  await q(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS collab_seeded boolean NOT NULL DEFAULT false`);
  await q(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS collab_seed_claimed_at timestamptz`);
  await q(
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'disabled'
     CHECK (embedding_status IN ('pending','processing','ready','failed','disabled'))`
  );
  // Text-anchored comments. Null for every comment that already exists, which
  // is exactly right: they were all made about the page as a whole. See
  // client/src/lib/commentAnchor.js for the shape and why it lives here rather
  // than as a mark in the document.
  await q(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor jsonb`);
  // Block storage. Additive for existing deployments; a fresh database gets
  // these from SCHEMA above and the ALTERs are no-ops.
  await q(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS order_key text COLLATE "C" NOT NULL DEFAULT 'a0'`);
  await migrateTreeOrder();
  // Only now that order_key is guaranteed to exist. The tree is read as
  // "children of this parent, in order", which is exactly this index; the
  // sibling list a drag measures against comes from it too.
  await q(
    `CREATE INDEX IF NOT EXISTS pages_sibling_order_idx ON pages (space_id, parent_id, order_key)
     WHERE deleted_at IS NULL`
  );
  // Exact-title lookup, the way `[[links]]` are matched: normalized, per space.
  // `resolve-titles` and the link table's own title matching both read through
  // this, so neither has to scan a space's pages to answer "what is titled X?".
  await q(
    `CREATE INDEX IF NOT EXISTS pages_title_norm_idx ON pages
     (space_id, lower(regexp_replace(btrim(title), '\\s+', ' ', 'g')))
     WHERE deleted_at IS NULL`
  );
  try {
    await q('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await q('CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops)');
  } catch (err) {
    console.log('pg_trgm unavailable, skipping fuzzy title index:', err.message);
  }
  try {
    await q('CREATE EXTENSION IF NOT EXISTS vector');
    await q(VECTOR_SCHEMA);
    await q(`ALTER TABLE page_chunks ADD COLUMN IF NOT EXISTS source_block_ids text[] NOT NULL DEFAULT '{}'`);
    await q('CREATE INDEX IF NOT EXISTS page_chunks_blocks_idx ON page_chunks USING gin (source_block_ids)');
    vectorAvailable = true;
  } catch (err) {
    console.log('pgvector unavailable, semantic search cannot be enabled:', err.message);
  }
  console.log('database schema ready');
}
