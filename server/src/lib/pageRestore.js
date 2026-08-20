// Taking a page back out of the trash.
//
// Delete is recursive: `DELETE /api/pages/:id` soft-deletes the page and every
// page beneath it in one statement. Restore was not, and while the tree was
// capped at one level of subpages that asymmetry cost one stranded subpage —
// annoying, visible, easy to fix by hand. With pages nesting to any depth
// (issue #24) the same asymmetry strands an entire branch: descendants sit in
// the trash carrying a `parent_id` that points at a page which is live again, so
// they are unreachable from the tree, absent from the page they belong under,
// and nothing in the trash list says they are there.
//
// So restore is recursive too, and the question becomes which descendants belong
// to *this* deletion. `deleted_at` answers it exactly: the recursive delete sets
// it from `now()`, which in postgres is the transaction timestamp, so every row
// soft-deleted by one operation carries the identical value to the microsecond.
// A subpage thrown away on its own last week has a different stamp and stays
// where it was put — restoring a parent must not resurrect something that was
// deleted deliberately and separately.
import { q } from '../db.js';

/**
 * Restore `page` and the branch that went to the trash with it.
 *
 * `page` is the row as read with `withDeleted`; only its id and `parent_id` are
 * used, since the deletion stamp is read and compared inside the query. The page
 * itself is re-homed to the root when its old parent is still deleted — a restored page has to land somewhere reachable,
 * and its descendants follow it there by keeping their own parents.
 *
 * Returns the restored rows, so the caller can re-queue whatever needs
 * re-indexing without asking for them again.
 */
export async function restorePage(page) {
  let parentId = page.parent_id;
  if (parentId) {
    const { rows } = await q('SELECT deleted_at FROM pages WHERE id = $1', [parentId]);
    if (!rows[0] || rows[0].deleted_at) parentId = null;
  }

  // The stamp is compared in SQL, never round-tripped through the caller.
  // Postgres keeps timestamps to the microsecond and a JavaScript Date only to
  // the millisecond, so `page.deleted_at` read out and sent back is a *different
  // value* — it matches the root row (matched by id) and nothing below it, which
  // is exactly the bug this function exists to fix, silently reintroduced.
  const { rows } = await q(
    `WITH RECURSIVE sub AS (
       SELECT id, ARRAY[id] AS path FROM pages WHERE id = $1
       UNION ALL
       SELECT p.id, sub.path || p.id FROM pages p JOIN sub ON p.parent_id = sub.id
       WHERE p.deleted_at = (SELECT deleted_at FROM pages WHERE id = $1)
         AND NOT (p.id = ANY(sub.path))
     )
     UPDATE pages SET deleted_at = NULL,
                      parent_id = CASE WHEN id = $1 THEN $2 ELSE parent_id END
     WHERE id IN (SELECT id FROM sub)
     RETURNING id, updated_at, embedding_status`,
    [page.id, parentId]
  );
  return rows;
}
