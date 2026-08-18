import crypto from 'node:crypto';
import { q } from '../db.js';
import { httpError, asyncRoute } from './util.js';

const SPACE_RANK = { reader: 1, writer: 2, admin: 3 };

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Resolve the calling user from a Bearer API token or the session cookie.
// Returns null when unauthenticated; never throws.
export async function resolveUser(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const hash = hashToken(header.slice(7).trim());
    const { rows } = await q(
      `SELECT u.id, u.username, u.name, u.role, u.active, u.preferences, t.id AS token_id
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
      [hash]
    );
    if (!rows[0] || !rows[0].active) return null;
    // fire-and-forget usage timestamp; not worth blocking the request on
    q(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [rows[0].token_id]).catch(() => {});
    const { token_id, ...user } = rows[0];
    return { ...user, viaToken: true };
  }
  if (req.session?.userId) {
    const { rows } = await q(
      'SELECT id, username, name, role, active, preferences FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!rows[0] || !rows[0].active) {
      req.session.destroy(() => {});
      return null;
    }
    return rows[0];
  }
  return null;
}

export const requireAuth = asyncRoute(async (req, _res, next) => {
  const user = await resolveUser(req);
  if (!user) throw httpError(401, 'Not authenticated');
  req.user = user;
  next();
});

export const requireAdmin = (req, _res, next) => {
  if (!['owner', 'admin'].includes(req.user?.role)) return next(httpError(403, 'Admin access required'));
  next();
};

export const isWorkspaceAdmin = (user) => ['owner', 'admin'].includes(user.role);

// Resolve the caller's effective role in a space: workspace owners/admins get
// space admin everywhere; everyone else needs an explicit membership row.
export async function spaceRole(user, spaceId) {
  if (isWorkspaceAdmin(user)) return 'admin';
  const { rows } = await q('SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2', [
    spaceId,
    user.id,
  ]);
  return rows[0]?.role || null;
}

export async function assertSpaceRole(user, spaceId, minRole) {
  const role = await spaceRole(user, spaceId);
  if (!role || SPACE_RANK[role] < SPACE_RANK[minRole]) {
    throw httpError(403, 'You do not have access to do this in this space');
  }
  return role;
}

export async function getPage(pageId, { withDeleted = false } = {}) {
  const { rows } = await q('SELECT * FROM pages WHERE id = $1', [pageId]);
  const page = rows[0];
  if (!page || (page.deleted_at && !withDeleted)) throw httpError(404, 'Page not found');
  return page;
}
