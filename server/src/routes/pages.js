import { Router } from 'express';
import { q, pool } from '../db.js';
import { asyncRoute, httpError, randomToken } from '../lib/util.js';
import { requireAuth, assertSpaceRole, getPage, accessibleSpacesQuery } from '../lib/auth.js';
import { searchPages, notePageChanged } from '../search/index.js';
import { getHub } from '../collab/index.js';
import { syncPageLinks, resolveLinksByTitle, unresolveStaleTitleLinks } from '../lib/links.js';
import { movePage, siblingOrderKeys } from '../lib/pageMove.js';
import { writePageBody } from '../lib/pageBody.js';
import { generateKeyBetween } from '../lib/orderKey.js';
import { publish, spaceAudience } from '../lib/events.js';

const router = Router();
router.use(requireAuth);

const TSV_SQL = `to_tsvector('english', left(coalesce($1,'') || ' ' || coalesce($2,''), 500000))`;
const VERSION_INTERVAL_MIN = 10;
// Mirrors the column default; spelled out here so a page created with a body
// and one created empty go down the same insert path.
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

// The page tree is one level of subpages deep, no more. Lifting that limit is
// tracked as its own piece of work; until then the rule lives on the server so
// no client can get around it. The matching rule for *moves* is in movePage,
// where it can read the same locked rows the move writes.
function assertCanTakeChildren(parent) {
  if (parent.parent_id) throw httpError(400, 'Pages can only be nested one level deep');
}

const accessibleSpacesCTE = accessibleSpacesQuery;

const spaceIdsOfPages = async (pageIds) => {
  if (!pageIds.length) return [];
  const { rows } = await q('SELECT DISTINCT space_id FROM pages WHERE id = ANY($1::uuid[])', [pageIds]);
  return rows.map((r) => r.space_id);
};

// ---- listing ----

router.get(
  '/spaces/:spaceId/pages',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.spaceId, 'reader');
    const { rows } = await q(
      `SELECT id, parent_id, title, icon, order_key, rev, updated_at FROM pages
       WHERE space_id = $1 AND deleted_at IS NULL ORDER BY order_key, created_at`,
      [req.params.spaceId]
    );
    res.json({ pages: rows });
  })
);

router.get(
  '/pages/recent',
  asyncRoute(async (req, res) => {
    const acc = accessibleSpacesCTE(req.user);
    const { rows } = await q(
      `SELECT p.id, p.space_id, p.title, p.icon, p.updated_at, s.name AS space_name, s.slug AS space_slug,
              u.name AS updated_by_name
       FROM pages p
       JOIN spaces s ON s.id = p.space_id
       LEFT JOIN users u ON u.id = p.updated_by
       WHERE p.deleted_at IS NULL AND p.space_id IN (${acc.sql})
       ORDER BY p.updated_at DESC LIMIT 16`,
      acc.params
    );
    res.json({ pages: rows });
  })
);

// Autocomplete for [[wiki links]] and the parent-page picker. Searches every
// space the caller can read, but floats the space they are writing in to the
// top so linking within a space stays a two-keystroke affair.
router.get(
  '/pages/link-search',
  asyncRoute(async (req, res) => {
    const query = (req.query.q || '').trim();
    const acc = accessibleSpacesCTE(req.user);
    const params = [...acc.params];
    const bind = (value) => `$${params.push(value)}`;

    const conds = [`p.deleted_at IS NULL`, `p.space_id IN (${acc.sql})`];
    if (query) conds.push(`p.title ILIKE ${bind(`%${query}%`)}`);
    if (req.query.exclude) conds.push(`p.id <> ${bind(req.query.exclude)}`);
    // Only a top-level page can take children, so the parent picker never
    // offers a subpage as a destination.
    if (req.query.topLevelOnly) conds.push(`p.parent_id IS NULL`);

    // A parent page has to live in the same space as its child, so the parent
    // picker asks for a hard filter where the [[link]] picker only wants the
    // current space floated to the top.
    let preferSpace = '';
    if (req.query.spaceId) {
      const spaceParam = bind(req.query.spaceId);
      if (req.query.onlySpace) conds.push(`p.space_id = ${spaceParam}`);
      else preferSpace = `(p.space_id = ${spaceParam}) DESC, `;
    }

    const { rows } = await q(
      `SELECT p.id, p.title, p.icon, p.space_id,
              s.slug AS space_slug, s.name AS space_name, s.icon AS space_icon
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ${preferSpace}p.updated_at DESC
       LIMIT 12`,
      params
    );
    res.json({ pages: rows });
  })
);

// Live titles for the page ids embedded in a document's [[links]]. A link
// stores the title it was written with, but the page it points at may have been
// renamed since — resolving by id here keeps the rendered chip honest.
router.get(
  '/pages/titles',
  asyncRoute(async (req, res) => {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, 100);
    if (!ids.length) return res.json({ pages: [] });
    const acc = accessibleSpacesCTE(req.user);
    const { rows } = await q(
      `SELECT p.id, p.title, p.icon, s.slug AS space_slug
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE p.id = ANY($${acc.params.length + 1}::uuid[])
         AND p.deleted_at IS NULL
         AND p.space_id IN (${acc.sql})`,
      [...acc.params, ids]
    );
    res.json({ pages: rows });
  })
);

// ---- CRUD ----

router.post(
  '/pages',
  asyncRoute(async (req, res) => {
    const { spaceId, parentId = null, title = '', content } = req.body || {};
    await assertSpaceRole(req.user, spaceId, 'writer');
    if (parentId) {
      const parent = await getPage(parentId);
      if (parent.space_id !== spaceId) throw httpError(400, 'Parent page is in a different space');
      assertCanTakeChildren(parent);
    }
    // Importing writes the body here rather than PATCHing it a moment later, so
    // the page is never observable — by the editor, by search, by another
    // client — in a half-created state with an empty body. Blocks are projected
    // inside the same transaction for the same reason: a page that exists with
    // a body but no rows in page_blocks would be invisible to the delta
    // endpoint and to block-scoped embedding until its next save.
    const hasContent = content !== undefined && content !== null;
    const conn = await pool.connect();
    let page;
    let changedBlockIds = [];
    try {
      await conn.query('BEGIN');
      const { rows: last } = await conn.query(
        `SELECT order_key FROM pages
         WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
         ORDER BY order_key DESC LIMIT 1`,
        [spaceId, parentId]
      );
      const orderKey = generateKeyBetween(last[0]?.order_key ?? null, null);
      const { rows } = await conn.query(
        `INSERT INTO pages (space_id, parent_id, title, order_key, created_by, updated_by,
                            content, text_content, tsv)
         VALUES ($1, $2, $3, $4, $5, $5,
                 $6::jsonb, $7, ${TSV_SQL.replace('$1', '$3').replace('$2', '$7')})
         RETURNING *`,
        [spaceId, parentId, title, orderKey, req.user.id, JSON.stringify(EMPTY_DOC), '']
      );
      page = rows[0];
      if (hasContent) {
        const written = await writePageBody({
          pageId: page.id,
          content,
          userId: req.user.id,
          conn,
        });
        page = { ...page, ...written.page, content: written.content };
        changedBlockIds = written.changedBlockIds;
      }
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    notePageChanged(page.id, page.updated_at, changedBlockIds);
    if (title) await resolveLinksByTitle(page);
    if (hasContent) await syncPageLinks(page.id, page.content, spaceId);
    res.status(201).json({ page });
  })
);

router.get(
  '/pages/:id',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    const myRole = await assertSpaceRole(req.user, page.space_id, 'reader');
    const { rows: crumbs } = await q(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, title, icon, 0 AS depth FROM pages WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_id, p.title, p.icon, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id
       ) SELECT id, title, icon FROM up WHERE id <> $1 ORDER BY depth DESC`,
      [page.id]
    );
    const { rows: space } = await q('SELECT id, name, slug, icon FROM spaces WHERE id = $1', [page.space_id]);
    const { rows: fav } = await q('SELECT 1 FROM favorites WHERE user_id = $1 AND page_id = $2', [
      req.user.id,
      page.id,
    ]);
    res.json({ page, myRole, breadcrumbs: crumbs, space: space[0], isFavorite: fav.length > 0 });
  })
);

router.patch(
  '/pages/:id',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    const { title, icon, content } = req.body || {};

    if (content !== undefined) {
      // Snapshot before overwriting if the latest version is stale.
      const { rows: last } = await q(
        `SELECT created_at FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [page.id]
      );
      const stale = !last[0] || Date.now() - new Date(last[0].created_at).getTime() > VERSION_INTERVAL_MIN * 60_000;
      if (stale) {
        await q(`INSERT INTO page_versions (page_id, title, content, created_by) VALUES ($1, $2, $3, $4)`, [
          page.id,
          page.title,
          page.content,
          req.user.id,
        ]);
      }
    }

    // The legacy whole-body write, kept as-is from the caller's point of view
    // and internally converted into a block diff. This is what lets the MCP
    // server, the collaboration snapshot writer and every existing API client
    // keep working unchanged through the migration — writePageBody works out
    // which blocks actually moved, so a client that resends an entire document
    // still only costs what it really changed.
    const written = await writePageBody({
      pageId: page.id,
      content,
      title,
      icon,
      userId: req.user.id,
    });
    notePageChanged(written.page.id, written.page.updated_at, written.changedBlockIds);

    // A body written through an API token — the MCP server, a script — is a
    // wholesale replacement that the CRDT cannot express as an edit, exactly
    // like a version restore. If the page was ever opened in the editor, its
    // stored ydoc still holds the old document and would be handed back to the
    // next reader, so the write looks like it silently did nothing. Drop the
    // doc and let the next client reseed from the JSON we just stored.
    //
    // Session-authenticated PATCHes are the editor's own snapshot writes and
    // must not do this: the CRDT there is the source they came from.
    if (content !== undefined && req.user.viaToken) {
      await q('DELETE FROM page_ydoc WHERE page_id = $1', [page.id]);
      await q(
        'UPDATE pages SET collab_seeded = false, collab_seed_claimed_at = NULL WHERE id = $1',
        [page.id]
      );
      await getHub()?.resetPage(page.id);
    }

    if (content !== undefined) await syncPageLinks(page.id, written.content, page.space_id);
    if (title !== undefined && title !== page.title) {
      // A rename can both attract dangling links and orphan ones that had
      // adopted the old title.
      await resolveLinksByTitle({ id: page.id, title: written.page.title, space_id: page.space_id });
      await unresolveStaleTitleLinks({ id: page.id, title: written.page.title });
    }
    res.json({ page: written.page });
  })
);

// ---- blocks ----

// How long a deleted block's tombstone is kept. A cache further behind than
// this refetches the whole document instead, which the endpoint tells it to do
// by answering `full: true` rather than by silently omitting the deletion.
const BLOCK_TOMBSTONE_TTL_DAYS = 30;

// The page's blocks in document order — the projection, read back.
//
// A reader that wants the whole page still uses GET /pages/:id and its single
// jsonb column; this is for anything that works block by block.
router.get(
  '/pages/:id/blocks',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const { rows } = await q(
      `SELECT block_id, type, content, order_key, hash, rev, updated_at
       FROM page_blocks WHERE page_id = $1 ORDER BY order_key`,
      [page.id]
    );
    res.json({ rev: Number(page.rev), blocks: rows });
  })
);

// What changed on this page since revision `since`.
//
// This is the endpoint the local-first cache is built on, and the reason
// `page_blocks.rev` records the revision of each block's own last change
// rather than the page's: a client holding revision 40 of a forty-block page
// asks what moved and is told about the one paragraph that did, instead of
// being sent the document again.
//
// Three answers are possible, and the distinction between the second and third
// is the one that matters:
//
//   * `since` is current — nothing changed, an empty delta.
//   * `since` is recent — the changed blocks, plus the ids of any deleted
//     since then, read from the tombstone table because a deletion leaves no
//     row to find.
//   * `since` is older than the tombstone horizon, or from a different page's
//     history — `full: true`, meaning "this cannot be answered incrementally,
//     refetch". Saying so explicitly is the point: silently returning a
//     partial delta would leave the client rendering a block that no longer
//     exists, with nothing to ever correct it.
router.get(
  '/pages/:id/delta',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const rev = Number(page.rev);
    const since = Number.parseInt(req.query.since, 10);

    if (!Number.isFinite(since) || since < 0 || since > rev) {
      // A `since` from the future is not a client being clever — it is a
      // client that cached a page, the page was wiped and recreated with the
      // same id, and its revisions started again. It has to start over.
      return res.json({ rev, full: true, blocks: [], deleted: [] });
    }
    if (since === rev) return res.json({ rev, full: false, blocks: [], deleted: [] });

    const { rows: horizon } = await q(
      `SELECT 1 FROM page_block_tombstones
       WHERE page_id = $1 AND rev > $2 AND deleted_at < now() - ($3 || ' days')::interval
       LIMIT 1`,
      [page.id, since, BLOCK_TOMBSTONE_TTL_DAYS]
    );
    if (horizon.length) return res.json({ rev, full: true, blocks: [], deleted: [] });

    const { rows: blocks } = await q(
      `SELECT block_id, type, content, order_key, hash, rev
       FROM page_blocks WHERE page_id = $1 AND rev > $2 ORDER BY order_key`,
      [page.id, since]
    );
    const { rows: deleted } = await q(
      'SELECT block_id FROM page_block_tombstones WHERE page_id = $1 AND rev > $2',
      [page.id, since]
    );
    res.json({
      rev,
      full: false,
      blocks,
      deleted: deleted.map((r) => r.block_id),
      // Order keys only say how the changed blocks sort against each other. A
      // client that deleted nothing and received nothing still needs to know
      // where they go, so the full order comes along — it is one short string
      // per block, far cheaper than the bodies it saves sending.
      order: (
        await q('SELECT block_id FROM page_blocks WHERE page_id = $1 ORDER BY order_key', [page.id])
      ).rows.map((r) => r.block_id),
    });
  })
);

// ---- realtime collaboration ----

// How long a seed claim is honoured before another client may take it over. A
// client that wins the claim and then dies (closed tab, lost network) would
// otherwise leave the page permanently stuck at an empty CRDT document.
const SEED_LEASE_SEC = 15;

// Converting the stored pages.content JSON into the CRDT has to happen exactly
// once. If two browsers open a fresh page simultaneously and both convert, both
// insertions are valid CRDT operations and the document ends up containing the
// page twice — Yjs has no way to know they meant the same thing. So the claim
// is arbitrated here, by a single conditional UPDATE: postgres row locking
// decides the winner and everyone else waits for the sync to arrive.
//
// The NOT EXISTS guard closes the other end of it: once any CRDT state has been
// persisted for the page, seeding can never fire again. Without it, deleting
// every word on a page would make it look unseeded and resurrect the old text.
router.post(
  '/pages/:id/collab/claim-seed',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    const { rows } = await q(
      `UPDATE pages SET collab_seed_claimed_at = now()
       WHERE id = $1 AND collab_seeded = false
         AND NOT EXISTS (SELECT 1 FROM page_ydoc y WHERE y.page_id = pages.id)
         AND (collab_seed_claimed_at IS NULL
              OR collab_seed_claimed_at < now() - ($2 || ' seconds')::interval)
       RETURNING id`,
      [page.id, SEED_LEASE_SEC]
    );
    res.json({ granted: rows.length > 0, content: rows.length > 0 ? page.content : null });
  })
);

// Confirmation that the winner actually wrote the content into the CRDT. Only
// now is the claim retired for good.
router.post(
  '/pages/:id/collab/confirm-seed',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    await q('UPDATE pages SET collab_seeded = true WHERE id = $1', [page.id]);
    res.json({ ok: true });
  })
);

// ---- links & backlinks ----

// Pages that point *at* this one. A link whose target sits in the trash simply
// stops appearing rather than being deleted, so restoring a page restores its
// backlinks too.
router.get(
  '/pages/:id/backlinks',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const acc = accessibleSpacesCTE(req.user);
    const { rows } = await q(
      `SELECT DISTINCT p.id, p.title, p.icon, p.space_id, p.updated_at,
              s.slug AS space_slug, s.name AS space_name
       FROM page_links l
       JOIN pages p ON p.id = l.source_id
       JOIN spaces s ON s.id = p.space_id
       WHERE l.target_id = $${acc.params.length + 1}
         AND p.deleted_at IS NULL
         AND p.id <> $${acc.params.length + 1}
         AND p.space_id IN (${acc.sql})
       ORDER BY p.updated_at DESC`,
      [...acc.params, page.id]
    );
    res.json({ backlinks: rows });
  })
);

// Pages this one points at, including links that resolve to nothing yet.
router.get(
  '/pages/:id/links',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const { rows } = await q(
      `SELECT l.target_id, l.target_title,
              t.title, t.icon, t.space_id, s.slug AS space_slug
       FROM page_links l
       LEFT JOIN pages t ON t.id = l.target_id AND t.deleted_at IS NULL
       LEFT JOIN spaces s ON s.id = t.space_id
       WHERE l.source_id = $1
       ORDER BY COALESCE(t.title, l.target_title)`,
      [page.id]
    );
    res.json({
      links: rows.map((r) => ({
        pageId: r.target_id && r.title !== null ? r.target_id : null,
        title: r.title ?? r.target_title,
        icon: r.icon || '',
        spaceSlug: r.space_slug || null,
      })),
    });
  })
);

// Reparent and/or reorder a page — the endpoint behind drag-and-drop in the
// sidebar as well as the tree's keyboard/menu commands.
//
// `index` is the slot the page should occupy among its new siblings, resolved
// against the database rather than the dragging browser's copy of the tree: two
// people rearranging the same list at once both get a sensible result instead of
// the second one overwriting a position computed from a stale list.
//
// A destination `spaceId` moves the page and its whole subtree between spaces,
// which needs write access on both sides — one to take the page out, one to put
// it in.
router.post(
  '/pages/:id/move',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    const { parentId = null, spaceId = null, orderKey } = req.body || {};
    // `position` is what the MCP server sends, and its own description of the
    // argument — "sort position among siblings" — is a slot, not the float the
    // column used to hold. Accepting it as one keeps that client working
    // untouched across the migration rather than silently appending every
    // move to the end of the list.
    const index = req.body?.index ?? req.body?.position;

    const targetSpaceId = spaceId || page.space_id;
    if (targetSpaceId !== page.space_id) await assertSpaceRole(req.user, targetSpaceId, 'writer');
    if (index !== undefined && index !== null && !Number.isInteger(index)) {
      throw httpError(400, 'index must be a whole number');
    }

    const result = await movePage({ page, parentId, spaceId: targetSpaceId, index, orderKey });

    if (result.crossSpace) {
      // Outside the move's transaction on purpose: this is the same link
      // resolution an edit runs, reused rather than reimplemented in SQL. It is
      // idempotent, so the worst a crash in the middle can do is leave some
      // links resolved against the old space until the page is next saved.
      //
      // Each moved page now resolves its own `[[Title]]` links against the new
      // space, and its title is newly available there to links that were
      // waiting for a page by that name.
      for (const movedId of result.movedIds) {
        const moved = await getPage(movedId);
        await syncPageLinks(moved.id, moved.content, moved.space_id);
        await resolveLinksByTitle(moved);
      }
    }

    // A tree redraw only concerns the space it happened in, so each side is
    // told about its own space and nothing else.
    const fromAudience = await spaceAudience(result.fromSpaceId);
    publish({ type: 'pages-changed', spaceId: result.fromSpaceId, userIds: fromAudience });
    const toAudience = result.crossSpace ? await spaceAudience(result.toSpaceId) : [];
    if (result.crossSpace) {
      publish({ type: 'pages-changed', spaceId: result.toSpaceId, userIds: toAudience });
    }

    // The move reaches further than the two trees. Anyone *reading* a moved
    // page has stale breadcrumbs and, after a cross-space move, a URL naming
    // the wrong space. And anyone reading a page that links into the subtree —
    // which can be a third space entirely — is looking at a link chip whose
    // cached URL was just rewritten underneath them. Those readers are exactly
    // the members of the spaces owning the pages that were rewritten, so the
    // event goes to them and stops there.
    const linkAudiences = await Promise.all(
      [...new Set(await spaceIdsOfPages(result.rewrittenIds))].map((id) => spaceAudience(id))
    );
    publish({
      type: 'page-moved',
      pageIds: result.movedIds,
      spaceId: result.toSpaceId,
      spaceSlug: result.spaceSlug,
      crossSpace: result.crossSpace,
      userIds: [...new Set([...fromAudience, ...toAudience, ...linkAudiences.flat()])],
    });

    res.json({ ok: true, spaceId: result.toSpaceId, spaceSlug: result.spaceSlug, orderKey: result.orderKey });
  })
);

// ---- moving and trashing a whole selection at once ----

// The endpoint behind a multi-select drag.
//
// Every page still goes through `movePage`, so there is exactly one definition
// of what moving a page means. What this adds is the two things a batch needs
// and a loop over `/pages/:id/move` could not give it:
//
//   * the destination gap is cut into `pageIds.length` order keys *before* the
//     first page is written, so the pages land in the order they were sent
//     instead of every one of them measuring the same gap and landing on top of
//     the last. `pageIds` arrives in the order the pages read in the tree, which
//     is how a selection keeps its shape across a drop.
//   * the batch is checked as a whole first. Refusing the fourth page of four
//     halfway through would leave the tree in a state nobody asked for and the
//     client with nothing to undo it with.
router.post(
  '/pages/move-many',
  asyncRoute(async (req, res) => {
    const { parentId = null, spaceId = null } = req.body || {};
    const pageIds = req.body?.pageIds;
    const index = req.body?.index;
    if (!Array.isArray(pageIds) || !pageIds.length) {
      throw httpError(400, 'pageIds must be a non-empty array');
    }
    if (new Set(pageIds).size !== pageIds.length) throw httpError(400, 'pageIds must not repeat');
    if (index !== undefined && index !== null && !Number.isInteger(index)) {
      throw httpError(400, 'index must be a whole number');
    }

    const pages = [];
    for (const id of pageIds) pages.push(await getPage(id));
    for (const sourceSpaceId of new Set(pages.map((p) => p.space_id))) {
      await assertSpaceRole(req.user, sourceSpaceId, 'writer');
    }
    const targetSpaceId = spaceId || pages[0].space_id;
    await assertSpaceRole(req.user, targetSpaceId, 'writer');

    if (parentId) {
      if (pageIds.includes(parentId)) throw httpError(400, 'Cannot move a page inside itself');
      const { rows: parent } = await q(
        'SELECT id, space_id, parent_id FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [parentId]
      );
      if (!parent[0]) throw httpError(404, 'Parent page not found');
      if (parent[0].space_id !== targetSpaceId) {
        throw httpError(400, 'Parent page is in a different space');
      }
      assertCanTakeChildren(parent[0]);
      // One level deep, for the batch as well as for one page: nothing carrying
      // subpages of its own can become a subpage.
      const { rows: withKids } = await q(
        'SELECT 1 FROM pages WHERE parent_id = ANY($1::uuid[]) AND deleted_at IS NULL LIMIT 1',
        [pageIds]
      );
      if (withKids.length) throw httpError(400, 'A page with subpages cannot itself become a subpage');
    }

    // Siblings as the destination will look with the whole selection lifted out
    // — not just the page currently being written, which is what the
    // single-page path measures. A page already sitting in this list would
    // otherwise be measured against the slot it is about to vacate.
    const { rows: siblings } = await q(
      `SELECT id, order_key FROM pages
       WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
         AND deleted_at IS NULL AND NOT (id = ANY($3::uuid[]))
       ORDER BY order_key, created_at`,
      [targetSpaceId, parentId, pageIds]
    );
    const slot = Number.isInteger(index) ? index : siblings.length;
    const keys = siblingOrderKeys(siblings, slot, pages.length);

    const results = [];
    for (const [i, page] of pages.entries()) {
      results.push(await movePage({ page, parentId, spaceId: targetSpaceId, orderKey: keys[i] }));
    }

    const movedIds = results.flatMap((r) => r.movedIds);
    const rewrittenIds = results.flatMap((r) => r.rewrittenIds);
    const crossSpace = results.some((r) => r.crossSpace);

    // Same link repair as a single move, run for each page that actually
    // changed space; see the note on `/pages/:id/move` for why it lives outside
    // the move's own transaction.
    for (const result of results) {
      if (!result.crossSpace) continue;
      for (const movedId of result.movedIds) {
        const moved = await getPage(movedId);
        await syncPageLinks(moved.id, moved.content, moved.space_id);
        await resolveLinksByTitle(moved);
      }
    }

    const audienceBySpace = new Map();
    for (const id of new Set([...results.map((r) => r.fromSpaceId), targetSpaceId])) {
      audienceBySpace.set(id, await spaceAudience(id));
    }
    for (const [id, userIds] of audienceBySpace) {
      publish({ type: 'pages-changed', spaceId: id, userIds });
    }

    const linkAudiences = await Promise.all(
      [...new Set(await spaceIdsOfPages(rewrittenIds))].map((id) => spaceAudience(id))
    );
    publish({
      type: 'page-moved',
      pageIds: movedIds,
      spaceId: targetSpaceId,
      spaceSlug: results[0].spaceSlug,
      crossSpace,
      userIds: [...new Set([...[...audienceBySpace.values()].flat(), ...linkAudiences.flat()])],
    });

    res.json({
      ok: true,
      spaceId: targetSpaceId,
      spaceSlug: results[0].spaceSlug,
      moved: pages.length,
    });
  })
);

// The endpoint behind "move N pages to trash". One statement rather than one
// request per page: a selection that is half in the trash is a state nobody
// asked for and the confirmation dialog did not describe.
router.post(
  '/pages/delete-many',
  asyncRoute(async (req, res) => {
    const pageIds = req.body?.pageIds;
    if (!Array.isArray(pageIds) || !pageIds.length) {
      throw httpError(400, 'pageIds must be a non-empty array');
    }
    const ids = [...new Set(pageIds)];
    const pages = [];
    for (const id of ids) pages.push(await getPage(id));
    for (const spaceId of new Set(pages.map((p) => p.space_id))) {
      await assertSpaceRole(req.user, spaceId, 'writer');
    }
    // Subpages go with their parents, exactly as the single-page delete does —
    // and a subpage that was *also* selected is simply already in the set.
    const { rowCount } = await q(
      `WITH RECURSIVE sub AS (
         SELECT id FROM pages WHERE id = ANY($1::uuid[])
         UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
       ) UPDATE pages SET deleted_at = now() WHERE id IN (SELECT id FROM sub)`,
      [ids]
    );
    res.json({ ok: true, trashed: rowCount });
  })
);

router.delete(
  '/pages/:id',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    await q(
      `WITH RECURSIVE sub AS (
         SELECT id FROM pages WHERE id = $1
         UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
       ) UPDATE pages SET deleted_at = now() WHERE id IN (SELECT id FROM sub)`,
      [page.id]
    );
    res.json({ ok: true });
  })
);

router.get(
  '/spaces/:spaceId/trash',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.spaceId, 'writer');
    const { rows } = await q(
      `SELECT id, title, icon, deleted_at FROM pages
       WHERE space_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100`,
      [req.params.spaceId]
    );
    res.json({ pages: rows });
  })
);

router.post(
  '/pages/:id/restore',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id, { withDeleted: true });
    await assertSpaceRole(req.user, page.space_id, 'writer');
    // Restore to root if the old parent is itself deleted.
    let parentId = page.parent_id;
    if (parentId) {
      const { rows } = await q('SELECT deleted_at FROM pages WHERE id = $1', [parentId]);
      if (!rows[0] || rows[0].deleted_at) parentId = null;
    }
    await q('UPDATE pages SET deleted_at = NULL, parent_id = $2 WHERE id = $1', [page.id, parentId]);
    if (page.embedding_status !== 'ready') notePageChanged(page.id, page.updated_at);
    res.json({ ok: true });
  })
);

router.delete(
  '/pages/:id/permanent',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id, { withDeleted: true });
    await assertSpaceRole(req.user, page.space_id, 'admin');
    await q('DELETE FROM pages WHERE id = $1', [page.id]);
    res.json({ ok: true });
  })
);

// ---- versions ----

router.get(
  '/pages/:id/versions',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const { rows } = await q(
      `SELECT v.id, v.title, v.created_at, u.name AS created_by_name
       FROM page_versions v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.page_id = $1 ORDER BY v.created_at DESC LIMIT 100`,
      [page.id]
    );
    res.json({ versions: rows });
  })
);

router.get(
  '/pages/:id/versions/:vid',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const { rows } = await q('SELECT * FROM page_versions WHERE id = $1 AND page_id = $2', [
      req.params.vid,
      page.id,
    ]);
    if (!rows[0]) throw httpError(404, 'Version not found');
    res.json({ version: rows[0] });
  })
);

router.post(
  '/pages/:id/versions/:vid/restore',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    const { rows } = await q('SELECT * FROM page_versions WHERE id = $1 AND page_id = $2', [
      req.params.vid,
      page.id,
    ]);
    const version = rows[0];
    if (!version) throw httpError(404, 'Version not found');
    await q(`INSERT INTO page_versions (page_id, title, content, created_by) VALUES ($1, $2, $3, $4)`, [
      page.id,
      page.title,
      page.content,
      req.user.id,
    ]);
    // A restore is a whole-document write like any other, so it goes down the
    // same path — which reprojects blocks, tombstones the ones the old
    // revision had that this one does not, and bumps `rev` so every cache
    // holding the newer document is told to come back for this one.
    //
    // Blocks that exist in both revisions keep their ids and their `rev`,
    // because their content hash is unchanged. That is worth more than it
    // sounds: restoring a version to undo an edit to one paragraph re-embeds
    // that paragraph's chunk, not the entire page.
    const written = await writePageBody({
      pageId: page.id,
      content: version.content,
      title: version.title,
      userId: req.user.id,
    });
    notePageChanged(written.page.id, written.page.updated_at, written.changedBlockIds);
    // A restore replaces the document wholesale, which the CRDT cannot express
    // as an edit. Drop the stored doc and the seed flag so the next client
    // rebuilds it from the restored JSON, and disconnect anyone still holding
    // the old one.
    await q('DELETE FROM page_ydoc WHERE page_id = $1', [page.id]);
    await q(
      'UPDATE pages SET collab_seeded = false, collab_seed_claimed_at = NULL WHERE id = $1',
      [page.id]
    );
    await getHub()?.resetPage(page.id);
    res.json({ ok: true });
  })
);

// ---- favorites ----

router.get(
  '/favorites',
  asyncRoute(async (req, res) => {
    const { rows } = await q(
      `SELECT p.id, p.space_id, p.title, p.icon, p.updated_at, s.name AS space_name, s.slug AS space_slug
       FROM favorites f JOIN pages p ON p.id = f.page_id JOIN spaces s ON s.id = p.space_id
       WHERE f.user_id = $1 AND p.deleted_at IS NULL ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ pages: rows });
  })
);

router.put(
  '/pages/:id/favorite',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    await q('INSERT INTO favorites (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      req.user.id,
      page.id,
    ]);
    res.json({ ok: true });
  })
);

router.delete(
  '/pages/:id/favorite',
  asyncRoute(async (req, res) => {
    await q('DELETE FROM favorites WHERE user_id = $1 AND page_id = $2', [req.user.id, req.params.id]);
    res.json({ ok: true });
  })
);

// ---- sharing ----

router.post(
  '/pages/:id/share',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    const token = page.share_token || randomToken();
    await q('UPDATE pages SET share_token = $1 WHERE id = $2', [token, page.id]);
    res.json({ token });
  })
);

router.delete(
  '/pages/:id/share',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    await q('UPDATE pages SET share_token = NULL WHERE id = $1', [page.id]);
    res.json({ ok: true });
  })
);

// ---- comments ----

router.get(
  '/pages/:id/comments',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const { rows } = await q(
      `SELECT c.*, u.name AS user_name, u.username FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.page_id = $1 ORDER BY c.created_at`,
      [page.id]
    );
    res.json({ comments: rows });
  })
);

router.post(
  '/pages/:id/comments',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'reader');
    const { content, parentId = null } = req.body || {};
    if (!content?.trim()) throw httpError(400, 'Comment cannot be empty');
    const { rows } = await q(
      `INSERT INTO comments (page_id, parent_id, user_id, content) VALUES ($1, $2, $3, $4) RETURNING *`,
      [page.id, parentId, req.user.id, content.trim()]
    );
    res.status(201).json({ comment: { ...rows[0], user_name: req.user.name, username: req.user.username } });
  })
);

router.patch(
  '/comments/:id',
  asyncRoute(async (req, res) => {
    const { rows } = await q('SELECT c.*, p.space_id FROM comments c JOIN pages p ON p.id = c.page_id WHERE c.id = $1', [
      req.params.id,
    ]);
    const comment = rows[0];
    if (!comment) throw httpError(404, 'Comment not found');
    const { content, resolved } = req.body || {};
    if (content !== undefined) {
      if (comment.user_id !== req.user.id) throw httpError(403, 'You can only edit your own comments');
      await q('UPDATE comments SET content = $1, updated_at = now() WHERE id = $2', [content.trim(), comment.id]);
    }
    if (resolved !== undefined) {
      await assertSpaceRole(req.user, comment.space_id, 'reader');
      await q('UPDATE comments SET resolved = $1, updated_at = now() WHERE id = $2', [Boolean(resolved), comment.id]);
    }
    res.json({ ok: true });
  })
);

router.delete(
  '/comments/:id',
  asyncRoute(async (req, res) => {
    const { rows } = await q('SELECT c.*, p.space_id FROM comments c JOIN pages p ON p.id = c.page_id WHERE c.id = $1', [
      req.params.id,
    ]);
    const comment = rows[0];
    if (!comment) throw httpError(404, 'Comment not found');
    if (comment.user_id !== req.user.id) await assertSpaceRole(req.user, comment.space_id, 'admin');
    await q('DELETE FROM comments WHERE id = $1', [comment.id]);
    res.json({ ok: true });
  })
);

// ---- search ----

router.get(
  '/search',
  asyncRoute(async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) return res.json({ results: [] });
    const results = await searchPages({
      user: req.user,
      query,
      space: req.query.space || null,
    });
    res.json({ results });
  })
);

export default router;
