// Moving a page in the tree — the whole operation, not just the parent pointer.
//
// A move is deceptively cheap to write (`UPDATE pages SET parent_id`) and
// deceptively easy to get wrong, because a page is the root of a subtree and
// the target of links written on other pages. Reparenting inside one space is
// the easy case; dragging a page into a *different* space drags its descendants
// with it and changes the URL every existing link renders. Everything that has
// to stay consistent through that lives here, in one transaction.
//
// What a move has to keep true:
//   * the subtree follows the page — descendants never end up orphaned in the
//     space they were dragged out of,
//   * attachments follow the pages that own them, so per-space storage
//     accounting and cleanup stay right,
//   * `[[wiki links]]` pointing at a moved page keep resolving: id-carrying
//     links are rewritten to the new space slug, and title-matched links
//     (which are scoped to a space) are re-resolved on both sides,
//   * the sibling ordering stays sane however many times pages have been
//     dropped into the same gap.
import { pool } from '../db.js';
import { httpError } from './util.js';
import { PAGE_LINK_NODE } from './links.js';
import { generateNKeysBetween, isOrderKey, keyForSlot } from './orderKey.js';

/**
 * Where to place a page dropped at `index` among `siblings`.
 *
 * `siblings` is the destination's child list *without* the page being moved,
 * ordered by their keys; `index` is the slot it should occupy afterwards. The
 * result is a key between its new neighbours, so a drop writes one row instead
 * of renumbering the list.
 *
 * This replaces `siblingPosition`, which returned a float and a `needsRenumber`
 * flag. The flag existed because the encoding could fail: doubles run out of
 * distinct midpoints after ~50 drops into one gap, and the caller had to notice
 * and respread the whole list to recover. There is nothing to notice now — a
 * string index always has room, so a drop is always one row, and the respread
 * path and its `MIN_GAP` floor are gone with it.
 *
 * That is not a hypothetical repair. Drag-and-drop page moves (PR #18) shipped
 * onto the float encoding, so every drop into an already-tight gap was one step
 * closer to two pages sharing a position and the tree ordering going undefined.
 */
export function siblingOrderKey(siblings, index) {
  return keyForSlot(siblings, index);
}

/**
 * Keys for `n` pages dropped into the same gap at once, in the order they
 * should end up.
 *
 * A multi-page drop cannot just call `siblingOrderKey` n times: each call would
 * measure the same gap and hand back the same key, and the pages would land on
 * top of each other in an order the database picks. Splitting the gap n ways up
 * front is what makes "the order they were in when you selected them" survive
 * the drop.
 *
 * `siblings` must exclude *every* page in the batch, not just the one being
 * written — otherwise a page already sitting in the destination list would be
 * measured against its own soon-to-be-vacated slot.
 */
export function siblingOrderKeys(siblings, index, n) {
  if (n <= 0) return [];
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? siblings[at - 1].order_key : null;
  const after = at < siblings.length ? siblings[at].order_key : null;
  return generateNKeysBetween(before, after, n);
}

/**
 * Rewrite the `spaceSlug` carried by every `pageLink` node whose target is in
 * `slugById`, returning a new document only if something actually changed.
 *
 * The attribute is a cache of "where does this link point", written when the
 * link was created. The node view re-resolves it live, so an open editor is
 * never wrong — but the stored JSON feeds markdown export, printing, public
 * share pages and copy-paste, all of which render the href straight from the
 * attribute. Leaving it stale is how a link survives a move on screen and
 * breaks everywhere else.
 */
export function rewriteLinkSlugs(node, slugById) {
  if (!node || typeof node !== 'object') return { node, changed: false };

  let changed = false;
  let next = node;

  if (node.type === PAGE_LINK_NODE && node.attrs?.pageId) {
    const slug = slugById.get(node.attrs.pageId);
    if (slug && slug !== node.attrs.spaceSlug) {
      next = { ...node, attrs: { ...node.attrs, spaceSlug: slug } };
      changed = true;
    }
  }

  if (Array.isArray(node.content)) {
    const content = [];
    let childChanged = false;
    for (const child of node.content) {
      const result = rewriteLinkSlugs(child, slugById);
      childChanged = childChanged || result.changed;
      content.push(result.node);
    }
    if (childChanged) {
      next = { ...next, content };
      changed = true;
    }
  }

  return { node: next, changed };
}

// ---- the move itself ----

/**
 * Move `page` under `parentId`, optionally into `spaceId`, at `index` among its
 * new siblings. Runs as one transaction: a half-applied move would leave pages
 * pointing at a parent in another space.
 *
 * `orderKey` is the lower-level way to say the same thing — an explicit sort
 * key, still honoured for API clients that compute one themselves.
 *
 * Returns what the caller needs in order to notify everyone: the ids that
 * changed space, the ids whose stored content was rewritten, and the
 * destination slug.
 */
export async function movePage({ page, parentId, spaceId, index, orderKey: explicitKey }) {
  const targetSpaceId = spaceId || page.space_id;
  const crossSpace = targetSpaceId !== page.space_id;
  const conn = await pool.connect();

  try {
    await conn.query('BEGIN');

    // Lock the row being moved. Two people dragging the same page at once then
    // serialise here rather than racing to write conflicting parents.
    const { rows: locked } = await conn.query(
      'SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [page.id]
    );
    if (!locked[0]) throw httpError(404, 'Page not found');

    const { rows: space } = await conn.query('SELECT id, slug FROM spaces WHERE id = $1', [targetSpaceId]);
    if (!space[0]) throw httpError(404, 'Space not found');

    // The subtree that travels with the page. Also the set the new parent must
    // not belong to — dropping a page onto its own descendant would detach the
    // whole branch into a cycle no tree query could ever reach.
    const { rows: subtree } = await conn.query(
      `WITH RECURSIVE sub AS (
         SELECT id FROM pages WHERE id = $1
         UNION ALL
         SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
       ) SELECT id FROM sub`,
      [page.id]
    );
    const subtreeIds = subtree.map((r) => r.id);

    if (parentId) {
      if (subtreeIds.includes(parentId)) {
        throw httpError(400, 'Cannot move a page inside itself');
      }
      const { rows: parent } = await conn.query(
        'SELECT id, space_id, parent_id FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [parentId]
      );
      if (!parent[0]) throw httpError(404, 'Parent page not found');
      // The parent is checked against the *destination*: during a cross-space
      // move it legitimately sits in a space the page is not in yet.
      if (parent[0].space_id !== targetSpaceId) {
        throw httpError(400, 'Parent page is in a different space');
      }
      // The tree is one level of subpages deep. Enforced here rather than at the
      // route so every way of moving a page — the menu, a drag, the API — is
      // held to it, and so the check reads the same locked rows the move writes.
      if (parent[0].parent_id) {
        throw httpError(400, 'Pages can only be nested one level deep');
      }
      if (subtreeIds.length > 1) {
        throw httpError(400, 'A page with subpages cannot itself become a subpage');
      }
    }

    // Siblings as they will be *after* the move, so an in-place reorder measures
    // gaps against the list the page is about to rejoin, not the one it left.
    const { rows: siblings } = await conn.query(
      `SELECT id, order_key FROM pages
       WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
         AND deleted_at IS NULL AND id <> $3
       ORDER BY order_key, created_at`,
      [targetSpaceId, parentId, page.id]
    );

    const slot = Number.isInteger(index) ? index : siblings.length;
    // One statement, always. The float version could reach here needing to
    // rewrite every sibling row first, which meant a drop into a crowded gap
    // cost O(siblings) writes and briefly reordered pages nobody had touched.
    const orderKey = isOrderKey(explicitKey) ? explicitKey : siblingOrderKey(siblings, slot);

    await conn.query('UPDATE pages SET parent_id = $1, order_key = $2, space_id = $3 WHERE id = $4', [
      parentId,
      orderKey,
      targetSpaceId,
      page.id,
    ]);

    let rewrittenIds = [];
    if (crossSpace) {
      // Descendants keep their parents and their order; only their space moves.
      await conn.query('UPDATE pages SET space_id = $1 WHERE id = ANY($2::uuid[])', [
        targetSpaceId,
        subtreeIds,
      ]);
      // Attachments are filed per space as well as per page; leaving them behind
      // would bill the old space for files it can no longer reach.
      await conn.query('UPDATE attachments SET space_id = $1 WHERE page_id = ANY($2::uuid[])', [
        targetSpaceId,
        subtreeIds,
      ]);
      rewrittenIds = await repointLinks(conn, subtreeIds, space[0].slug);
    }

    await conn.query('COMMIT');
    return {
      movedIds: subtreeIds,
      rewrittenIds,
      spaceSlug: space[0].slug,
      fromSpaceId: page.space_id,
      toSpaceId: targetSpaceId,
      crossSpace,
      parentId,
      orderKey,
    };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * The one link repair that has to happen inside the move's transaction, plus
 * the one that only this function knows how to do.
 *
 * Everything a moved page links *out* to is recomputed by `syncPageLinks` once
 * the move commits — the same path an ordinary edit takes, so there is no second
 * implementation of link resolution to keep in step. What that path cannot see
 * is the other direction: the pages left behind that pointed *in*.
 */
async function repointLinks(conn, movedIds, newSlug) {
  // Title-matched links resolve within a single space, so a page leaving its
  // space stops being the answer for `[[Its Title]]` written back there.
  // Dropping those to unresolved is the honest result — the link now points at
  // nothing in its own space, which is what the chip should show. (Links that
  // carry an id are deliberately untouched: following the page is their job.)
  await conn.query(
    `UPDATE page_links l SET target_id = NULL
     FROM pages src, pages tgt
     WHERE l.source_id = src.id
       AND l.target_id = tgt.id
       AND NOT l.by_id
       AND l.target_id = ANY($1::uuid[])
       AND src.space_id <> tgt.space_id`,
    [movedIds]
  );

  // Id-carrying links keep resolving, but the slug baked into their stored
  // `pageLink` node is now wrong. Rewrite it in every document pointing into
  // the subtree — including documents in the space the page just joined, whose
  // links were written before it got there.
  const slugById = new Map(movedIds.map((id) => [id, newSlug]));
  const { rows: sources } = await conn.query(
    `SELECT DISTINCT p.id, p.content
     FROM page_links l JOIN pages p ON p.id = l.source_id
     WHERE l.target_id = ANY($1::uuid[]) AND p.deleted_at IS NULL`,
    [movedIds]
  );

  const rewrittenIds = [];
  for (const source of sources) {
    const { node, changed } = rewriteLinkSlugs(source.content, slugById);
    if (!changed) continue;
    // Deliberately not touching updated_at/updated_by: nobody edited this page,
    // and a link repair should not push it to the top of "recently updated" or
    // re-embed text that did not change.
    await conn.query('UPDATE pages SET content = $1 WHERE id = $2', [JSON.stringify(node), source.id]);
    rewrittenIds.push(source.id);
  }
  return rewrittenIds;
}
