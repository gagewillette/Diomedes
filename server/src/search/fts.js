import { q } from '../db.js';
import { accessibleSpacesQuery } from '../lib/auth.js';

const HEADLINE_OPTS = 'StartSel=[[[, StopSel=]]], MaxFragments=2, MaxWords=18, MinWords=6';

// Postgres full-text search over pages the user can read. This is the whole of
// search when semantic search is off, and one of the two rankers when it is on.
export async function ftsSearch({ user, query, space, limit = 25 }) {
  const acc = accessibleSpacesQuery(user);
  const params = [...acc.params, query];
  const text = `$${params.length}`;
  let spaceFilter = '';
  if (space) {
    params.push(space);
    spaceFilter = ` AND p.space_id = $${params.length}`;
  }
  params.push(limit);
  const max = `$${params.length}`;

  const { rows } = await q(
    `SELECT p.id, p.space_id, p.title, p.icon, p.updated_at, s.name AS space_name, s.slug AS space_slug,
            ts_rank(p.tsv, plainto_tsquery('english', ${text})) AS rank,
            ts_headline('english', left(p.text_content, 4000), plainto_tsquery('english', ${text}),
                        '${HEADLINE_OPTS}') AS snippet
     FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.deleted_at IS NULL AND p.space_id IN (${acc.sql})
       AND (p.tsv @@ plainto_tsquery('english', ${text}) OR p.title ILIKE '%' || ${text} || '%')
       ${spaceFilter}
     ORDER BY rank DESC, p.updated_at DESC LIMIT ${max}`,
    params
  );
  return rows;
}
