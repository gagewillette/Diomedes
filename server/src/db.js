import pg from 'pg';
import { EMBED_DIMS } from './search/config.js';

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
  position double precision NOT NULL DEFAULT 0,
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
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS page_chunks_page_idx ON page_chunks (page_id);
CREATE INDEX IF NOT EXISTS page_chunks_embedding_idx ON page_chunks USING hnsw (embedding vector_cosine_ops);
`;

// Set by migrate(); semantic search stays off when the extension is missing so
// a plain postgres:16 image keeps working.
export let vectorAvailable = false;

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
  await q(
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'disabled'
     CHECK (embedding_status IN ('pending','processing','ready','failed','disabled'))`
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
    vectorAvailable = true;
  } catch (err) {
    console.log('pgvector unavailable, semantic search cannot be enabled:', err.message);
  }
  console.log('database schema ready');
}
