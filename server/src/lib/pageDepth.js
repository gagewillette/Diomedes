// How deep the page tree is allowed to go, and how to measure where a page sits.
//
// The tree used to be capped at one level of subpages (issue #21), which made
// depth a yes/no question: a parent either had a parent or it did not. Issue #24
// lifted that, and "arbitrary depth" still cannot mean unbounded — the recursive
// CTEs behind breadcrumbs, subtree export and delete all walk one row per level,
// the sidebar indents per level, and the breadcrumb bar renders per level. A
// scripted client that built a 10,000-deep chain would make every one of those
// pathological, so the cap moves rather than disappears: from "1" to a number
// no human tree reaches but a loop does.
//
// Levels are 1-based, the way a person counts them: a page with no parent is at
// level 1, its child at level 2. MAX_PAGE_DEPTH is the deepest level a page may
// occupy, so 20 means nineteen nested subpages under a root page.
import { q } from '../db.js';
import { httpError } from './util.js';

export const MAX_PAGE_DEPTH = 20;

// Both walks take an optional connection: inside `movePage` they must run on the
// transaction that holds the advisory lock and the row locks, or they would be
// answering about a tree the move is not writing. Off a transaction they fall
// back to the pool, which is what the advisory route checks want.
//
// Both walks carry `path` purely as a cycle guard. `movePage` serialises moves
// per space and rejects a parent inside the moved subtree, so a cycle should not
// exist — but these queries are the ones that would hang forever if one did, and
// a WHERE NOT ... = ANY(path) is cheaper than the incident.

/**
 * Which level `pageId` sits at: 1 for a page with no parent, 2 for its child.
 * Returns 0 if the page does not exist (or is deleted), which makes
 * `assertDepthFits` treat a vanished parent as no constraint — the caller has
 * already 404'd on it by then.
 */
export async function pageLevel(pageId, conn = { query: q }) {
  const { rows } = await conn.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, 1 AS level, ARRAY[id] AS path FROM pages WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id, up.level + 1, up.path || p.id
       FROM pages p JOIN up ON p.id = up.parent_id
       WHERE NOT (p.id = ANY(up.path))
     ) SELECT coalesce(max(level), 0) AS level FROM up`,
    [pageId]
  );
  return rows[0].level;
}

/**
 * How many levels of living descendants hang below `pageId`: 0 for a leaf, 1 for
 * a page with children but no grandchildren. This is the part of a move that the
 * one-level cap used to sidestep by refusing to move anything with subpages at
 * all — the subtree travels with the page, so the limit applies to its deepest
 * page, not just to the page being dragged.
 */
export async function subtreeHeight(pageId, conn = { query: q }) {
  const { rows } = await conn.query(
    `WITH RECURSIVE down AS (
       SELECT id, 0 AS height, ARRAY[id] AS path FROM pages WHERE id = $1
       UNION ALL
       SELECT p.id, down.height + 1, down.path || p.id
       FROM pages p JOIN down ON p.parent_id = down.id
       WHERE p.deleted_at IS NULL AND NOT (p.id = ANY(down.path))
     ) SELECT coalesce(max(height), 0) AS height FROM down`,
    [pageId]
  );
  return rows[0].height;
}

/**
 * Refuse a placement that would push any page past MAX_PAGE_DEPTH.
 *
 * `parentLevel` is the level of the destination parent (0 when landing at the
 * root, since a root page's own level is 1). `height` is how far the moved
 * subtree extends below the page itself — 0 when creating a page, since a page
 * that does not exist yet has nothing under it.
 *
 * The error names the limit rather than the offending page: whichever page in
 * the batch tripped it, the fix is the same and the user is looking at a
 * destination, not at a page.
 */
export function assertDepthFits(parentLevel, height = 0) {
  const deepest = parentLevel + 1 + height;
  if (deepest > MAX_PAGE_DEPTH) {
    throw httpError(400, `Pages can only be nested ${MAX_PAGE_DEPTH} levels deep`);
  }
}
