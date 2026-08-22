import crypto from 'node:crypto';
import { q } from '../db.js';
import { httpError, asyncRoute } from './util.js';

const SPACE_RANK = { reader: 1, writer: 2, admin: 3 };

// Roles a space can hand out to everyone. Deliberately no 'admin': space
// administration stays with named members and workspace admins.
export const PUBLIC_ROLES = ['reader', 'writer'];
export const SPACE_ROLES = ['reader', 'writer', 'admin'];

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Resolve the calling user from a Bearer API token or the session cookie.
// Returns null when unauthenticated; never throws.
export async function resolveUser(req) {
  // Read the raw header rather than express's req.get: this also runs against
  // the plain IncomingMessage of a websocket upgrade, which has no express
  // request methods on it.
  const header = req.headers?.authorization;
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

// Subquery (with $1-based params) yielding the space ids the user can read:
// the spaces they are a member of, plus every space with public access on.
export const accessibleSpacesQuery = (user) =>
  isWorkspaceAdmin(user)
    ? { sql: 'SELECT id FROM spaces', params: [] }
    : {
        sql: `SELECT space_id AS id FROM space_members WHERE user_id = $1
              UNION
              SELECT id FROM spaces WHERE public_role IS NOT NULL`,
        params: [user.id],
      };

// The whole precedence rule in one place: an explicit membership row always
// wins over the space's public role — it can raise access above the public
// level or hold a user below it. No row at all falls back to the public role,
// and a private space (public_role null) stays members-only.
export const resolveSpaceRole = ({ memberRole, publicRole }) => memberRole || publicRole || null;

// Resolve the caller's effective role in a space: workspace owners/admins get
// space admin everywhere; everyone else gets their membership role, falling
// back to whatever the space grants the public.
export async function spaceRole(user, spaceId) {
  if (isWorkspaceAdmin(user)) return 'admin';
  const { rows } = await q(
    `SELECT s.public_role, m.role AS member_role
     FROM spaces s LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = $2
     WHERE s.id = $1`,
    [spaceId, user.id]
  );
  if (!rows[0]) return null;
  return resolveSpaceRole({ memberRole: rows[0].member_role, publicRole: rows[0].public_role });
}

export async function assertSpaceRole(user, spaceId, minRole) {
  const role = await spaceRole(user, spaceId);
  if (!role || SPACE_RANK[role] < SPACE_RANK[minRole]) {
    throw httpError(403, 'You do not have access to do this in this space');
  }
  return role;
}

// Everything on `pages` except `text_content` and `tsv`. Those two are search
// artifacts -- `text_content` feeds ts_headline, `tsv` is only ever matched
// against the GIN index -- and no reader of a getPage() result touches either.
// A `SELECT *` sent both to the browser on every page open, which meant a page
// response carried the document three times over: once as `content`, which
// renders, and twice more as text nothing on the client can read.
//
// The list is explicit rather than a `SELECT * EXCEPT`, which Postgres does not
// have. That makes it something a migration has to remember: a column added to
// the table is invisible here until it is added to this list too.
const PAGE_COLUMNS = `id, space_id, parent_id, title, icon, content, order_key,
                      rev, created_by, updated_by, created_at, updated_at,
                      deleted_at, share_token, collab_seeded,
                      collab_seed_claimed_at, embedding_status`;

export async function getPage(pageId, { withDeleted = false } = {}) {
  const { rows } = await q(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1`, [pageId]);
  const page = rows[0];
  if (!page || (page.deleted_at && !withDeleted)) throw httpError(404, 'Page not found');
  return page;
}
