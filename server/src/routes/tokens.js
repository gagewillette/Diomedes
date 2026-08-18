import { Router } from 'express';
import { q } from '../db.js';
import { asyncRoute, httpError, randomToken } from '../lib/util.js';
import { requireAuth, hashToken } from '../lib/auth.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const { rows } = await q(
      `SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ tokens: rows });
  })
);

// The plaintext token is returned exactly once; only its sha256 is stored.
router.post(
  '/',
  asyncRoute(async (req, res) => {
    if (req.user.viaToken) throw httpError(403, 'Tokens cannot mint other tokens — log in with a session');
    const name = req.body?.name?.trim();
    if (!name) throw httpError(400, 'Token name is required');
    const { rows: count } = await q('SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1', [req.user.id]);
    if (count[0].n >= 20) throw httpError(400, 'Token limit reached (20) — revoke unused tokens first');
    const token = `dio_${randomToken(32)}`;
    const { rows } = await q(
      `INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1, $2, $3)
       RETURNING id, name, created_at`,
      [req.user.id, name, hashToken(token)]
    );
    res.status(201).json({ token, info: rows[0] });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const { rowCount } = await q('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rowCount) throw httpError(404, 'Token not found');
    res.json({ ok: true });
  })
);

export default router;
