// The exporting half of cross-workspace transfer: minting, listing and
// redeeming the per-space keys that let another workspace pull a slice of this
// one.
//
// A key is a bearer credential. Whoever holds the code can read the pages it
// names, from any workspace, without an account here — which is why minting is
// restricted to space admins, why only the hash is stored, and why every
// redemption is stamped onto the row so an admin can see a key being used.
import { q } from '../db.js';
import { httpError, randomToken } from './util.js';
import { hashToken } from './auth.js';
import {
  SNAPSHOT_VERSION,
  encodeTransferCode,
  expandSelection,
  KEY_NAME_MAX,
  MAX_EXPORT_PAGES,
} from './spaceTransfer.js';

// Enough keys to keep one per partner workspace, few enough that the management
// list stays a list rather than a search problem.
export const MAX_KEYS_PER_SPACE = 25;

// How long a key may be minted for. Never-expiring keys are allowed (expiresAt
// null) because a long-lived mirror between two workspaces is a real use, but
// the modal defaults to an expiry — a credential with no end date is the kind
// of thing that outlives the reason it was created.
export const MAX_EXPIRY_DAYS = 365;

// The prefix stored alongside the hash so the management list can tell two keys
// apart. Short enough to be useless as a head start on guessing the rest.
const PREFIX_LENGTH = 6;

/**
 * The origin other workspaces should pull from.
 *
 * APP_URL is the configured public address and is the right answer whenever it
 * is set — behind a tunnel or a reverse proxy the request's own Host header is
 * an internal name that no other workspace can reach. The request is only a
 * fallback for a workspace that never set APP_URL, and it honours the proxy
 * headers for the same reason.
 */
export function exportOrigin(req) {
  const configured = (process.env.APP_URL || '').trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* misconfigured APP_URL falls through to the request */
    }
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) throw httpError(500, 'Cannot determine this workspace’s public address — set APP_URL');
  return `${proto}://${host}`;
}

/** Shape a key row for the management list. The secret is never in here. */
export const publicKey = (row) => ({
  id: row.id,
  name: row.name,
  prefix: row.key_prefix,
  pageCount: Array.isArray(row.selection) ? row.selection.length : 0,
  contentCount: Array.isArray(row.selection)
    ? row.selection.filter((s) => s.includeContent).length
    : 0,
  createdAt: row.created_at,
  createdByName: row.created_by_name ?? null,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
  useCount: row.use_count,
  status: keyStatus(row),
});

export function keyStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export async function listExportKeys(spaceId) {
  const { rows } = await q(
    `SELECT k.*, u.name AS created_by_name
     FROM space_export_keys k LEFT JOIN users u ON u.id = k.created_by
     WHERE k.space_id = $1 ORDER BY k.created_at DESC`,
    [spaceId]
  );
  return rows.map(publicKey);
}

/**
 * Mint a key over a page selection.
 *
 * The selection is expanded and frozen here rather than at redemption time —
 * see the note on the table in db.js. The plaintext code is returned exactly
 * once; after this function returns, nothing in the system can reproduce it.
 */
export async function createExportKey({ spaceId, userId, name, pageIds, expiresInDays, origin }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw httpError(400, 'Key name is required');
  if (trimmed.length > KEY_NAME_MAX) {
    throw httpError(400, `Key name must be ${KEY_NAME_MAX} characters or fewer`);
  }
  if (!Array.isArray(pageIds) || !pageIds.length) {
    throw httpError(400, 'Select at least one page to export');
  }

  const { rows: live } = await q(
    `SELECT id, parent_id, order_key FROM pages
     WHERE space_id = $1 AND deleted_at IS NULL`,
    [spaceId]
  );
  const liveIds = new Set(live.map((p) => p.id));
  // A page the caller cannot see, or one deleted between opening the modal and
  // pressing the button, is refused rather than quietly dropped: an export that
  // silently contains less than the screen showed is worse than an error.
  const unknown = pageIds.filter((id) => !liveIds.has(id));
  if (unknown.length) throw httpError(400, 'Some selected pages no longer exist in this space');

  const selection = expandSelection(live, pageIds);
  if (selection.length > MAX_EXPORT_PAGES) {
    throw httpError(400, `An export can carry at most ${MAX_EXPORT_PAGES} pages`);
  }

  const { rows: counted } = await q(
    `SELECT count(*)::int AS n FROM space_export_keys WHERE space_id = $1 AND revoked_at IS NULL`,
    [spaceId]
  );
  if (counted[0].n >= MAX_KEYS_PER_SPACE) {
    throw httpError(400, `Key limit reached (${MAX_KEYS_PER_SPACE}) — revoke unused keys first`);
  }

  let expiresAt = null;
  if (expiresInDays !== null && expiresInDays !== undefined && expiresInDays !== '') {
    const days = Number(expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
      throw httpError(400, `Expiry must be between 1 and ${MAX_EXPIRY_DAYS} days`);
    }
    expiresAt = new Date(Date.now() + days * 86_400_000);
  }

  const secret = randomToken(32);
  const { rows } = await q(
    `INSERT INTO space_export_keys (space_id, name, key_hash, key_prefix, selection, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      spaceId,
      trimmed,
      hashToken(secret),
      secret.slice(0, PREFIX_LENGTH),
      JSON.stringify(selection),
      userId,
      expiresAt,
    ]
  );

  return { code: encodeTransferCode(origin, secret), key: publicKey(rows[0]) };
}

export async function revokeExportKey(spaceId, keyId) {
  const { rowCount } = await q(
    `UPDATE space_export_keys SET revoked_at = now()
     WHERE id = $1 AND space_id = $2 AND revoked_at IS NULL`,
    [keyId, spaceId]
  );
  if (!rowCount) throw httpError(404, 'Export key not found');
}

/**
 * Look a secret up without leaking which of several failures happened.
 *
 * The lookup is by hash, so a wrong secret finds nothing; a revoked or expired
 * one finds a row that is refused. All three answer 404 with the same sentence,
 * because distinguishing "no such key" from "that key was revoked" tells an
 * unauthenticated caller whether they guessed a real credential.
 */
export async function resolveExportKey(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(secret)) {
    throw httpError(404, 'Export key is not valid');
  }
  const { rows } = await q('SELECT * FROM space_export_keys WHERE key_hash = $1', [
    hashToken(secret),
  ]);
  const key = rows[0];
  if (!key || keyStatus(key) !== 'active') throw httpError(404, 'Export key is not valid');
  return key;
}

/**
 * Assemble the payload the other workspace receives.
 *
 * Pages are read back against the frozen id list, so a page deleted since the
 * key was minted simply drops out — but a page whose *ancestor* dropped out
 * would be orphaned, so anything left without a parent in the payload is
 * re-anchored at the root rather than pointing at a row that is not there.
 */
export async function buildSnapshot(key) {
  const selection = Array.isArray(key.selection) ? key.selection : [];
  const contentIds = selection.filter((s) => s.includeContent).map((s) => s.id);
  const allIds = selection.map((s) => s.id);

  const { rows: spaceRows } = await q('SELECT name, icon, description FROM spaces WHERE id = $1', [
    key.space_id,
  ]);
  const space = spaceRows[0];
  if (!space) throw httpError(404, 'Export key is not valid');

  const { rows } = await q(
    `SELECT id, parent_id, title, icon, order_key, content
     FROM pages WHERE id = ANY($1::uuid[]) AND space_id = $2 AND deleted_at IS NULL`,
    [allIds, key.space_id]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const present = new Set(byId.keys());
  const withContent = new Set(contentIds);

  // Emit in the frozen order, which expandSelection already put in document
  // order, so the importer can write parents before children in one pass.
  const pages = [];
  for (const entry of selection) {
    const row = byId.get(entry.id);
    if (!row) continue;
    const parentId = row.parent_id && present.has(row.parent_id) ? row.parent_id : null;
    const includeContent = withContent.has(entry.id);
    pages.push({
      id: row.id,
      parentId,
      title: row.title,
      icon: row.icon,
      orderKey: row.order_key,
      // A placeholder carries no body at all: the flag is what the importing
      // side shows the user, and an empty doc would be indistinguishable from a
      // page that genuinely is empty.
      includeContent,
      content: includeContent ? row.content : null,
    });
  }

  return {
    version: SNAPSHOT_VERSION,
    space: { name: space.name, icon: space.icon, description: space.description },
    exportName: key.name,
    exportedAt: new Date().toISOString(),
    pages,
  };
}

/**
 * Stamp a redemption onto the key. Deliberately not awaited by the route: a
 * failure to record a use is not a reason to refuse a valid pull, and the
 * caller is already streaming the snapshot by the time this runs.
 */
export async function noteExportKeyUse(keyId) {
  await q(
    'UPDATE space_export_keys SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1',
    [keyId]
  );
}
