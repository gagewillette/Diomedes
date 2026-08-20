import { Router } from 'express';
import { q } from '../db.js';
import { asyncRoute, httpError, extractText, randomToken } from '../lib/util.js';
import { requireAuth, assertSpaceRole, getPage, accessibleSpacesQuery } from '../lib/auth.js';
import { searchPages, notePageChanged } from '../search/index.js';
import { getHub } from '../collab/index.js';
import { syncPageLinks, resolveLinksByTitle, unresolveStaleTitleLinks } from '../lib/links.js';

const router = Router();
router.use(requireAuth);

const TSV_SQL = `to_tsvector('english', left(coalesce($1,'') || ' ' || coalesce($2,''), 500000))`;
const VERSION_INTERVAL_MIN = 10;
// Mirrors the column default; spelled out here so a page created with a body
// and one created empty go down the same insert path.
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

// The page tree is one level of subpages deep, no more. Lifting that limit is
// tracked as its own piece of work; until then the rule lives here so no client
// can get around it.
//
// A parent is rejected when it would push the tree past that depth, either
// because the parent is already a subpage or because the page being moved has
// subpages of its own that would be dragged down with it.
async function assertNestingAllowed(parent, page = null) {
  if (parent.parent_id) {
    throw httpError(400, 'Pages can only be nested one level deep');
  }
  if (page) {
    const { rows } = await q(
      'SELECT 1 FROM pages WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1',
      [page.id]
    );
    if (rows.length) {
      throw httpError(400, 'A page with subpages cannot itself become a subpage');
    }
  }
}

const accessibleSpacesCTE = accessibleSpacesQuery;

// ---- listing ----

router.get(
  '/spaces/:spaceId/pages',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.spaceId, 'reader');
    const { rows } = await q(
      `SELECT id, parent_id, title, icon, position, updated_at FROM pages
       WHERE space_id = $1 AND deleted_at IS NULL ORDER BY position, created_at`,
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
      await assertNestingAllowed(parent);
    }
    const { rows: pos } = await q(
      `SELECT COALESCE(MAX(position), 0) + 1000 AS next FROM pages
       WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
      [spaceId, parentId]
    );
    // Importing writes the body here rather than PATCHing it a moment later, so
    // the page is never observable — by the editor, by search, by another
    // client — in a half-created state with an empty body.
    const hasContent = content !== undefined && content !== null;
    const body = hasContent ? content : EMPTY_DOC;
    const text = hasContent ? extractText(content) : '';
    const { rows } = await q(
      `INSERT INTO pages (space_id, parent_id, title, position, created_by, updated_by,
                          content, text_content, tsv)
       VALUES ($1, $2, $3, $4, $5, $5,
               $6::jsonb, $7, ${TSV_SQL.replace('$1', '$3').replace('$2', '$7')})
       RETURNING *`,
      [spaceId, parentId, title, pos[0].next, req.user.id, JSON.stringify(body), text]
    );
    notePageChanged(rows[0].id, rows[0].updated_at);
    if (title) await resolveLinksByTitle(rows[0]);
    if (hasContent) await syncPageLinks(rows[0].id, content, spaceId);
    res.status(201).json({ page: rows[0] });
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

    const newTitle = title !== undefined ? title : page.title;
    const newContent = content !== undefined ? content : page.content;
    const text = content !== undefined ? extractText(newContent) : page.text_content;
    const { rows } = await q(
      `UPDATE pages SET title = $3, icon = COALESCE($4, icon), content = $5, text_content = $6,
              tsv = ${TSV_SQL.replace('$1', '$3').replace('$2', '$6')},
              updated_by = $2, updated_at = now()
       WHERE id = $1 RETURNING id, title, icon, updated_at`,
      [page.id, req.user.id, newTitle, icon, JSON.stringify(newContent), text]
    );
    notePageChanged(rows[0].id, rows[0].updated_at);

    if (content !== undefined) await syncPageLinks(page.id, newContent, page.space_id);
    if (title !== undefined && title !== page.title) {
      // A rename can both attract dangling links and orphan ones that had
      // adopted the old title.
      await resolveLinksByTitle({ id: page.id, title: newTitle, space_id: page.space_id });
      await unresolveStaleTitleLinks({ id: page.id, title: newTitle });
    }
    res.json({ page: rows[0] });
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

router.post(
  '/pages/:id/move',
  asyncRoute(async (req, res) => {
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');
    const { parentId = null, position } = req.body || {};
    if (parentId) {
      const parent = await getPage(parentId);
      if (parent.space_id !== page.space_id) throw httpError(400, 'Cannot move across spaces');
      // prevent cycles: walk up from the new parent
      let cursor = parent;
      while (cursor) {
        if (cursor.id === page.id) throw httpError(400, 'Cannot move a page inside itself');
        cursor = cursor.parent_id ? await getPage(cursor.parent_id) : null;
      }
      await assertNestingAllowed(parent, page);
    }
    let pos = position;
    if (pos === undefined || pos === null) {
      const { rows } = await q(
        `SELECT COALESCE(MAX(position), 0) + 1000 AS next FROM pages
         WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
        [page.space_id, parentId]
      );
      pos = rows[0].next;
    }
    await q('UPDATE pages SET parent_id = $1, position = $2 WHERE id = $3', [parentId, pos, page.id]);
    res.json({ ok: true });
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
    const text = extractText(version.content);
    const { rows: restored } = await q(
      `UPDATE pages SET title = $2, content = $3, text_content = $4,
              tsv = ${TSV_SQL.replace('$1', '$2').replace('$2', '$4')},
              updated_by = $5, updated_at = now() WHERE id = $1 RETURNING id, updated_at`,
      [page.id, version.title, JSON.stringify(version.content), text, req.user.id]
    );
    notePageChanged(restored[0].id, restored[0].updated_at);
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
