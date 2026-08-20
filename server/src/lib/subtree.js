import { q } from '../db.js';

// A page and every live page beneath it, in one query.
//
// There is no depth limit here on purpose. The UI currently only lets a page be
// nested one level, but parent_id has always been an arbitrary tree and that
// limit is going away — a walk that stopped at a fixed depth would start
// quietly dropping grandchildren the day it does, and an export that silently
// loses pages is worse than one that fails. The recursion is guarded against a
// parent cycle instead, which is the only way it can fail to terminate.
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
  return q(
    `WITH RECURSIVE sub AS (
       SELECT ${list}, ARRAY[id] AS path FROM pages WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT ${prefixed}, sub.path || p.id
       FROM pages p JOIN sub ON p.parent_id = sub.id
       WHERE p.deleted_at IS NULL AND NOT p.id = ANY(sub.path)
     )
     SELECT ${list} FROM sub ORDER BY order_key, created_at`,
    [pageId]
  ).then(({ rows }) => rows);
}
