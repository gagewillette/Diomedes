import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { asyncRoute, httpError, slugify } from '../lib/util.js';
import { requireAuth } from '../lib/auth.js';
import { getWorkspace } from '../lib/workspace.js';

const USERNAME_RE = /^[a-zA-Z0-9._@-]{2,64}$/;

export default function authRoutes(redis) {
  const router = Router();

  const loginKey = (req, username) => `diomedes:login:${req.ip}:${username.toLowerCase()}`;

  router.get(
    '/status',
    asyncRoute(async (_req, res) => {
      const { rows } = await q('SELECT count(*)::int AS n FROM users');
      const workspace = await getWorkspace();
      res.json({ needsSetup: rows[0].n === 0, workspaceName: workspace.name });
    })
  );

  // First-run: create the owner account and a starter space.
  router.post(
    '/setup',
    asyncRoute(async (req, res) => {
      const { rows } = await q('SELECT count(*)::int AS n FROM users');
      if (rows[0].n > 0) throw httpError(403, 'Workspace is already set up');
      const { workspaceName, name, username, password } = req.body || {};
      if (!name?.trim() || !USERNAME_RE.test(username || '')) throw httpError(400, 'Invalid name or username');
      if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');

      const hash = await bcrypt.hash(password, 12);
      const { rows: users } = await q(
        `INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id, username, name, role`,
        [username.toLowerCase(), name.trim(), hash]
      );
      const user = users[0];
      await q(`INSERT INTO settings (key, value) VALUES ('workspace', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [
        { name: workspaceName?.trim() || 'Diomedes' },
      ]);
      const { rows: spaces } = await q(
        `INSERT INTO spaces (name, slug, description, icon, created_by) VALUES ('General', 'general', 'Your first space', '🏠', $1) RETURNING id`,
        [user.id]
      );
      await q(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')`, [spaces[0].id, user.id]);
      req.session.userId = user.id;
      res.json({ user });
    })
  );

  router.post(
    '/login',
    asyncRoute(async (req, res) => {
      const { username, password } = req.body || {};
      if (!username || !password) throw httpError(400, 'Username and password are required');

      const key = loginKey(req, username);
      const attempts = Number((await redis.get(key)) || 0);
      if (attempts >= 10) throw httpError(429, 'Too many failed attempts. Try again in 15 minutes.');

      const { rows } = await q('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
      const user = rows[0];
      const ok = user && (await bcrypt.compare(password, user.password_hash));
      if (!ok || !user.active) {
        await redis.multi().incr(key).expire(key, 900).exec();
        throw httpError(401, 'Invalid username or password');
      }
      await redis.del(key);
      await new Promise((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve()))
      );
      req.session.userId = user.id;
      res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    })
  );

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get(
    '/me',
    requireAuth,
    asyncRoute(async (req, res) => {
      // `workspace` carries the workspace-wide switches (data savings); the flat
      // `workspaceName` stays for the header and older clients.
      const workspace = await getWorkspace();
      res.json({ user: req.user, workspaceName: workspace.name, workspace });
    })
  );

  // User-specific editor/UI preferences, stored as an opaque JSON blob.
  router.patch(
    '/preferences',
    requireAuth,
    asyncRoute(async (req, res) => {
      const prefs = req.body?.preferences;
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
        throw httpError(400, 'preferences must be an object');
      }
      const json = JSON.stringify(prefs);
      if (json.length > 8192) throw httpError(400, 'preferences too large');
      await q('UPDATE users SET preferences = $1 WHERE id = $2', [json, req.user.id]);
      res.json({ preferences: prefs });
    })
  );

  router.patch(
    '/profile',
    requireAuth,
    asyncRoute(async (req, res) => {
      const name = req.body?.name?.trim();
      if (!name) throw httpError(400, 'Name is required');
      await q('UPDATE users SET name = $1 WHERE id = $2', [name, req.user.id]);
      res.json({ ok: true });
    })
  );

  router.post(
    '/change-password',
    requireAuth,
    asyncRoute(async (req, res) => {
      const { current, next } = req.body || {};
      if (!next || next.length < 8) throw httpError(400, 'New password must be at least 8 characters');
      const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (!(await bcrypt.compare(current || '', rows[0].password_hash))) {
        throw httpError(403, 'Current password is incorrect');
      }
      await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 12), req.user.id]);
      res.json({ ok: true });
    })
  );

  return router;
}

export { USERNAME_RE };
