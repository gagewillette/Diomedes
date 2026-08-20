import { Router } from 'express';
import { q } from '../db.js';
import { asyncRoute, httpError, slugify } from '../lib/util.js';
import { requireAuth, requireAdmin, isWorkspaceAdmin, assertSpaceRole, spaceRole } from '../lib/auth.js';
import { publish, adminAudience, spaceAudience } from '../lib/events.js';

const router = Router();
router.use(requireAuth);

// Push a membership change to everyone who can see the space. `userId` is the
// member who changed, so clients can tell "my own access moved" (reload the
// space) from "someone else's did" (just refresh the members list).
async function announceMembership(spaceId, userId) {
  const userIds = await spaceAudience(spaceId, [userId]);
  publish({ type: 'space-members-changed', spaceId, userId, userIds });
  publish({ type: 'spaces-changed', userIds });
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    let rows;
    if (isWorkspaceAdmin(req.user)) {
      ({ rows } = await q(
        `SELECT s.*, COALESCE(m.role, 'admin') AS my_role,
                (SELECT count(*)::int FROM pages p WHERE p.space_id = s.id AND p.deleted_at IS NULL) AS page_count
         FROM spaces s LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
         ORDER BY s.created_at`,
        [req.user.id]
      ));
    } else {
      ({ rows } = await q(
        `SELECT s.*, m.role AS my_role,
                (SELECT count(*)::int FROM pages p WHERE p.space_id = s.id AND p.deleted_at IS NULL) AS page_count
         FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
         ORDER BY s.created_at`,
        [req.user.id]
      ));
    }
    res.json({ spaces: rows });
  })
);

router.post(
  '/',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { name, description = '', icon = '📚' } = req.body || {};
    if (!name?.trim()) throw httpError(400, 'Space name is required');
    let slug = slugify(name);
    const { rows: existing } = await q('SELECT 1 FROM spaces WHERE slug = $1', [slug]);
    if (existing.length) slug = `${slug}-${Date.now().toString(36)}`;
    const { rows } = await q(
      `INSERT INTO spaces (name, slug, description, icon, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), slug, description, icon, req.user.id]
    );
    await q(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [
      rows[0].id,
      req.user.id,
    ]);
    publish({ type: 'spaces-changed', userIds: await adminAudience([req.user.id]) });
    res.status(201).json({ space: { ...rows[0], my_role: 'admin' } });
  })
);

router.get(
  '/:slug',
  asyncRoute(async (req, res) => {
    const { rows } = await q('SELECT * FROM spaces WHERE slug = $1', [req.params.slug]);
    const space = rows[0];
    if (!space) throw httpError(404, 'Space not found');
    const myRole = await spaceRole(req.user, space.id);
    if (!myRole) throw httpError(403, 'You are not a member of this space');
    res.json({ space: { ...space, my_role: myRole } });
  })
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.id, 'admin');
    const { name, description, icon } = req.body || {};
    if (name !== undefined && !name.trim()) throw httpError(400, 'Name cannot be empty');
    const { rows } = await q(
      `UPDATE spaces SET name = COALESCE($1, name), description = COALESCE($2, description), icon = COALESCE($3, icon)
       WHERE id = $4 RETURNING *`,
      [name?.trim(), description, icon, req.params.id]
    );
    if (!rows[0]) throw httpError(404, 'Space not found');
    publish({ type: 'spaces-changed', userIds: await spaceAudience(req.params.id) });
    res.json({ space: rows[0] });
  })
);

router.delete(
  '/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const audience = await spaceAudience(req.params.id); // membership rows go away with the space
    await q('DELETE FROM spaces WHERE id = $1', [req.params.id]);
    publish({ type: 'spaces-changed', userIds: audience });
    res.json({ ok: true });
  })
);

// Aggregate stats for the space information card: membership, page counts,
// and how much room documents / attachments actually occupy.
router.get(
  '/:id/stats',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.id, 'reader');
    const id = req.params.id;

    const [space, members, pages, attachments, versions, comments, contributors] = await Promise.all([
      q(
        `SELECT s.id, s.name, s.slug, s.icon, s.description, s.created_at, u.name AS created_by_name
         FROM spaces s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
        [id]
      ),
      q(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE m.role = 'admin')::int AS admins,
                count(*) FILTER (WHERE m.role = 'writer')::int AS writers,
                count(*) FILTER (WHERE m.role = 'reader')::int AS readers,
                count(*) FILTER (WHERE NOT u.active)::int AS inactive
         FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1`,
        [id]
      ),
      q(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
                count(*) FILTER (WHERE deleted_at IS NULL AND parent_id IS NULL)::int AS top_level,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS trashed,
                count(*) FILTER (WHERE deleted_at IS NULL AND share_token IS NOT NULL)::int AS shared,
                COALESCE(sum(pg_column_size(content) + pg_column_size(text_content))
                         FILTER (WHERE deleted_at IS NULL), 0)::bigint AS bytes,
                COALESCE(sum(length(text_content)) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS characters,
                max(updated_at) FILTER (WHERE deleted_at IS NULL) AS last_updated_at
         FROM pages WHERE space_id = $1`,
        [id]
      ),
      q(
        `SELECT count(*)::int AS count, COALESCE(sum(size), 0)::bigint AS bytes,
                count(DISTINCT mime)::int AS mime_types, max(created_at) AS last_uploaded_at
         FROM attachments WHERE space_id = $1`,
        [id]
      ),
      q(
        `SELECT count(*)::int AS count, COALESCE(sum(pg_column_size(v.content)), 0)::bigint AS bytes
         FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.space_id = $1`,
        [id]
      ),
      q(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT c.resolved)::int AS open
         FROM comments c JOIN pages p ON p.id = c.page_id
         WHERE p.space_id = $1 AND p.deleted_at IS NULL`,
        [id]
      ),
      q(
        `SELECT u.name, u.username, count(*)::int AS pages
         FROM pages p JOIN users u ON u.id = p.updated_by
         WHERE p.space_id = $1 AND p.deleted_at IS NULL
         GROUP BY u.id, u.name, u.username ORDER BY pages DESC, u.name LIMIT 5`,
        [id]
      ),
    ]);

    if (!space.rows[0]) throw httpError(404, 'Space not found');

    const p = pages.rows[0];
    const a = attachments.rows[0];
    const v = versions.rows[0];

    res.json({
      stats: {
        space: space.rows[0],
        members: members.rows[0],
        pages: {
          active: p.active,
          topLevel: p.top_level,
          trashed: p.trashed,
          shared: p.shared,
          characters: Number(p.characters),
          bytes: Number(p.bytes),
          lastUpdatedAt: p.last_updated_at,
        },
        files: {
          count: a.count,
          bytes: Number(a.bytes),
          mimeTypes: a.mime_types,
          lastUploadedAt: a.last_uploaded_at,
        },
        versions: { count: v.count, bytes: Number(v.bytes) },
        comments: comments.rows[0],
        totalBytes: Number(p.bytes) + Number(a.bytes) + Number(v.bytes),
        topContributors: contributors.rows,
      },
    });
  })
);

router.get(
  '/:id/members',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.id, 'reader');
    const { rows } = await q(
      `SELECT m.user_id, m.role, m.added_at, u.username, u.name, u.active
       FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1 ORDER BY m.added_at`,
      [req.params.id]
    );
    res.json({ members: rows });
  })
);

router.post(
  '/:id/members',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.id, 'admin');
    const { userId, role = 'reader' } = req.body || {};
    if (!['admin', 'writer', 'reader'].includes(role)) throw httpError(400, 'Invalid role');
    const { rows: u } = await q('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!u.length) throw httpError(404, 'User not found');
    await q(
      `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = $3`,
      [req.params.id, userId, role]
    );
    await announceMembership(req.params.id, userId);
    res.status(201).json({ ok: true });
  })
);

router.patch(
  '/:id/members/:userId',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.id, 'admin');
    const { role } = req.body || {};
    if (!['admin', 'writer', 'reader'].includes(role)) throw httpError(400, 'Invalid role');
    await q('UPDATE space_members SET role = $1 WHERE space_id = $2 AND user_id = $3', [
      role,
      req.params.id,
      req.params.userId,
    ]);
    await announceMembership(req.params.id, req.params.userId);
    res.json({ ok: true });
  })
);

router.delete(
  '/:id/members/:userId',
  asyncRoute(async (req, res) => {
    await assertSpaceRole(req.user, req.params.id, 'admin');
    // Audience first: the removed user has to be told they lost access.
    const audience = await spaceAudience(req.params.id, [req.params.userId]);
    await q('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    publish({ type: 'space-members-changed', spaceId: req.params.id, userId: req.params.userId, userIds: audience });
    publish({ type: 'spaces-changed', userIds: audience });
    res.json({ ok: true });
  })
);

export default router;
