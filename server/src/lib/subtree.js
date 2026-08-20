import { q } from '../db.js';

// A page and every live page beneath it, in one query.
//
// There is no depth limit here on purpose. Pages nest to MAX_PAGE_DEPTH levels
// (lib/pageDepth.js), and that number is a policy on where a page may be *put*,
// not a promise about what is already in the table — a walk that stopped at a
// fixed depth would quietly drop pages the day the policy moved, and an export
// that silently loses pages is worse than one that fails. The recursion is
// guarded against a parent cycle instead, which is the only way it can fail to
// terminate.
const COLUMNS = ['id', 'parent_id', 'title', 'icon', 'order_key', 'created_at', 'updated_at'];

/**
 * Rows for `pageId` and all its descendants, ordered by order_key so callers
 * see siblings in the order the tree renders them. Trashed pages are left out,
 * along with anything below them.
 */
export function pageSubtree(pageId, { withContent = false } = {}) {
  const cols = withContent ? [...COLUMNS, 'content'] : COLUMNS;
  const list = cols.join(', ');
  const prefixed = cols.map((c) => `p.${c}`).join(', ');
  // Ordered by the *path* of order keys, not by the key alone.
  //
  // An order key is only unique and only meaningful within one sibling group:
  // the first child of page A and the first child of page B are both "a0". A
  // flat `ORDER BY order_key` therefore interleaves cousins from different
  // branches and can sort a page ahead of its own parent, which is not document
  // order — it is document order only for a tree so shallow that every row is
  // either the single root or one of its children, which is what this query used
  // to be run against.
  //
  // Concatenating each page's key onto its parent's path gives an array that
  // sorts exactly the way the tree reads: postgres compares arrays element by
  // element, and a prefix sorts before what extends it, so a parent always
  // precedes its subtree and siblings stay in their own order within it. The
  // root carries an empty path and comes first.
  //
  // The empty anchor array is collated "C" to match `pages.order_key`, which is
  // declared that way so fractional index strings compare byte by byte. Postgres
  // requires the two terms of a recursive CTE to agree on collation, and without
  // the clause the anchor picks up the database default and the query is
  // rejected outright.
  return q(
    `WITH RECURSIVE sub AS (
       SELECT ${list}, ARRAY[id] AS path,
              ARRAY[]::text[] COLLATE "C" AS sort_path
       FROM pages WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT ${prefixed}, sub.path || p.id, sub.sort_path || coalesce(p.order_key, '')
       FROM pages p JOIN sub ON p.parent_id = sub.id
       WHERE p.deleted_at IS NULL AND NOT p.id = ANY(sub.path)
     )
     SELECT ${list} FROM sub ORDER BY sort_path, created_at`,
    [pageId]
  ).then(({ rows }) => rows);
}
