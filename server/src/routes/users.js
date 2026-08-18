import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { asyncRoute, httpError } from '../lib/util.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { USERNAME_RE } from './auth.js';

const router = Router();
router.use(requireAuth);

// Non-admins can list users too (needed for @mentions), but only basic fields.
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const { rows } = await q(
      `SELECT id, username, name, role, active, created_at FROM users ORDER BY created_at`
    );
    if (['owner', 'admin'].includes(req.user.role)) return res.json({ users: rows });
    res.json({ users: rows.filter((u) => u.active).map(({ id, username, name }) => ({ id, username, name })) });
  })
);

router.post(
  '/',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { username, name, password, role = 'member' } = req.body || {};
    if (!USERNAME_RE.test(username || '')) throw httpError(400, 'Username must be 2-64 chars (letters, numbers, . _ @ -)');
    if (!name?.trim()) throw httpError(400, 'Name is required');
    if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (!['admin', 'member'].includes(role)) throw httpError(400, 'Role must be admin or member');
    if (role === 'admin' && req.user.role !== 'owner') throw httpError(403, 'Only the owner can create admins');

    const { rows: dup } = await q('SELECT 1 FROM users WHERE username = $1', [username.toLowerCase()]);
    if (dup.length) throw httpError(409, 'That username is taken');

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await q(
      `INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, username, name, role, active, created_at`,
      [username.toLowerCase(), name.trim(), hash, role]
    );
    res.status(201).json({ user: rows[0] });
  })
);

router.patch(
  '/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const target = rows[0];
    if (!target) throw httpError(404, 'User not found');
    if (target.role === 'owner' && req.user.id !== target.id) throw httpError(403, 'Cannot modify the owner');

    const { name, role, active, password } = req.body || {};
    if (role !== undefined) {
      if (!['admin', 'member'].includes(role)) throw httpError(400, 'Invalid role');
      if (req.user.role !== 'owner') throw httpError(403, 'Only the owner can change roles');
      if (target.role === 'owner') throw httpError(400, 'The owner role cannot be changed');
      await q('UPDATE users SET role = $1 WHERE id = $2', [role, target.id]);
    }
    if (active !== undefined) {
      if (target.id === req.user.id) throw httpError(400, 'You cannot deactivate yourself');
      await q('UPDATE users SET active = $1 WHERE id = $2', [Boolean(active), target.id]);
    }
    if (name !== undefined) {
      if (!name.trim()) throw httpError(400, 'Name cannot be empty');
      await q('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), target.id]);
    }
    if (password !== undefined) {
      if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
      await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, 12), target.id]);
    }
    const { rows: updated } = await q(
      'SELECT id, username, name, role, active, created_at FROM users WHERE id = $1',
      [target.id]
    );
    res.json({ user: updated[0] });
  })
);

router.delete(
  '/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const target = rows[0];
    if (!target) throw httpError(404, 'User not found');
    if (target.role === 'owner') throw httpError(403, 'The owner cannot be deleted');
    if (target.id === req.user.id) throw httpError(400, 'You cannot delete yourself');
    await q('DELETE FROM users WHERE id = $1', [target.id]);
    res.json({ ok: true });
  })
);

export default router;
