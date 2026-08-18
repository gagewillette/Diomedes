import { Router } from 'express';
import { q, pool } from '../db.js';
import { asyncRoute, httpError, extractText, randomToken } from '../lib/util.js';
import { requireAuth, assertSpaceRole, getPage, isWorkspaceAdmin } from '../lib/auth.js';

const router = Router();
router.use(requireAuth);

const TSV_SQL = `to_tsvector('english', left(coalesce($1,'') || ' ' || coalesce($2,''), 500000))`;
const VERSION_INTERVAL_MIN = 10;

const accessibleSpacesCTE = (user) =>
  isWorkspaceAdmin(user)
    ? { sql: 'SELECT id FROM spaces', params: [] }
    : { sql: 'SELECT space_id AS id FROM space_members WHERE user_id = $1', params: [user.id] };

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

// ---- CRUD ----

router.post(
  '/pages',
  asyncRoute(async (req, res) => {
    const { spaceId, parentId = null, title = '' } = req.body || {};
    await assertSpaceRole(req.user, spaceId, 'writer');
    if (parentId) {
      const parent = await getPage(parentId);
      if (parent.space_id !== spaceId) throw httpError(400, 'Parent page is in a different space');
    }
    const { rows: pos } = await q(
      `SELECT COALESCE(MAX(position), 0) + 1000 AS next FROM pages
       WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
      [spaceId, parentId]
    );
    const { rows } = await q(
      `INSERT INTO pages (space_id, parent_id, title, position, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [spaceId, parentId, title, pos[0].next, req.user.id]
    );
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
    res.json({ page: rows[0] });
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
    await q(
      `UPDATE pages SET title = $2, content = $3, text_content = $4,
              tsv = ${TSV_SQL.replace('$1', '$2').replace('$2', '$4')},
              updated_by = $5, updated_at = now() WHERE id = $1`,
      [page.id, version.title, JSON.stringify(version.content), text, req.user.id]
    );
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
    const acc = accessibleSpacesCTE(req.user);
    const spaceFilter = req.query.space ? ` AND p.space_id = $${acc.params.length + 2}` : '';
    const params = [...acc.params, query];
    if (req.query.space) params.push(req.query.space);
    const { rows } = await q(
      `SELECT p.id, p.space_id, p.title, p.icon, p.updated_at, s.name AS space_name, s.slug AS space_slug,
              ts_rank(p.tsv, plainto_tsquery('english', $${acc.params.length + 1})) AS rank,
              ts_headline('english', left(p.text_content, 4000), plainto_tsquery('english', $${acc.params.length + 1}),
                          'StartSel=[[[, StopSel=]]], MaxFragments=2, MaxWords=18, MinWords=6') AS snippet
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE p.deleted_at IS NULL AND p.space_id IN (${acc.sql})
         AND (p.tsv @@ plainto_tsquery('english', $${acc.params.length + 1}) OR p.title ILIKE '%' || $${acc.params.length + 1} || '%')
         ${spaceFilter}
       ORDER BY rank DESC, p.updated_at DESC LIMIT 25`,
      params
    );
    res.json({ results: rows });
  })
);

export default router;
