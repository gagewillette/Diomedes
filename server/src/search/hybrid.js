import { q } from '../db.js';
import { accessibleSpacesQuery } from '../lib/auth.js';
import { embedQuery, toVector } from './embed.js';
import { ftsSearch } from './fts.js';

// Each ranker contributes 1/(RRF_K + rank). Reciprocal rank fusion needs no
// score calibration between the two — which matters, because ts_rank and cosine
// similarity are not on remotely comparable scales.
const RRF_K = 60;
const CANDIDATES = 50;

// Cosine distance beyond which a chunk is not really about the query. Without
// this the nearest neighbour always wins, so an unrelated page surfaces
// whenever full-text finds nothing at all.
const MAX_DISTANCE = 0.7;

// Nearest chunks by cosine distance, restricted to readable, live pages.
async function vectorSearch({ user, embedding, space, limit }) {
  const acc = accessibleSpacesQuery(user);
  const params = [...acc.params, toVector(embedding), MAX_DISTANCE];
  const vec = `$${params.length - 1}`;
  const maxDistance = `$${params.length}`;
  let spaceFilter = '';
  if (space) {
    params.push(space);
    spaceFilter = ` AND p.space_id = $${params.length}`;
  }
  params.push(limit);
  const max = `$${params.length}`;

  const { rows } = await q(
    `SELECT DISTINCT ON (c.page_id) c.page_id, c.content, c.embedding <=> ${vec}::vector AS distance
     FROM page_chunks c JOIN pages p ON p.id = c.page_id
     WHERE p.deleted_at IS NULL AND c.embedding IS NOT NULL AND p.space_id IN (${acc.sql})
       AND c.embedding <=> ${vec}::vector < ${maxDistance}
       ${spaceFilter}
     ORDER BY c.page_id, distance
     LIMIT ${max}`,
    params
  );
  // DISTINCT ON forces ordering by page_id first, so re-sort by actual distance.
  return rows.sort((a, b) => a.distance - b.distance);
}

async function pageMetadata(ids) {
  if (!ids.length) return new Map();
  const { rows } = await q(
    `SELECT p.id, p.space_id, p.title, p.icon, p.updated_at, s.name AS space_name, s.slug AS space_slug
     FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Chunks carry a "Title > Heading" context prefix that is noise in a snippet.
const snippetFrom = (chunk) => {
  const body = chunk.includes('\n\n') ? chunk.slice(chunk.indexOf('\n\n') + 2) : chunk;
  return body.replace(/\s+/g, ' ').trim().slice(0, 240);
};

export async function hybridSearch({ user, query, space, limit = 25 }) {
  const embedding = await embedQuery(query);
  const [fts, vectors] = await Promise.all([
    ftsSearch({ user, query, space, limit: CANDIDATES }),
    vectorSearch({ user, embedding, space, limit: CANDIDATES }),
  ]);

  const scores = new Map();
  const add = (id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank));
  fts.forEach((row, i) => add(row.id, i + 1));
  vectors.forEach((row, i) => add(row.page_id, i + 1));

  const ftsById = new Map(fts.map((r) => [r.id, r]));
  const chunkById = new Map(vectors.map((r) => [r.page_id, r]));
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const missing = ordered.map(([id]) => id).filter((id) => !ftsById.has(id));
  const meta = await pageMetadata(missing);

  return ordered
    .map(([id, score]) => {
      const base = ftsById.get(id) || meta.get(id);
      if (!base) return null;
      const chunk = chunkById.get(id);
      // ts_headline returns the leading text unmarked when nothing matched, so
      // prefer the semantic passage whenever FTS did not actually hit.
      const snippet = ftsById.has(id) && base.snippet?.includes('[[[')
        ? base.snippet
        : chunk
          ? snippetFrom(chunk.content)
          : base.snippet || '';
      return { ...base, rank: score, snippet, semantic: Boolean(chunk) };
    })
    .filter(Boolean);
}
