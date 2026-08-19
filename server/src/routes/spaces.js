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
