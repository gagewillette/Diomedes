// The importing half of cross-workspace transfer: fetching a snapshot from the
// workspace that minted the code, and writing it into a new space here.
//
// The fetch is the security-sensitive part. This server is being asked to make
// an HTTP request to an address supplied by a user, which is the shape of a
// server-side request forgery: a code whose origin is `http://169.254.169.254`
// turns an import button into a cloud-metadata reader. Minting is admin-only,
// but "an admin typed it" is not the same as "an admin meant it" — a code is
// pasted from somewhere else by definition, and its origin is not something the
// person pasting it can read. So the address is checked before it is used.
import dns from 'node:dns/promises';
import net from 'node:net';
import { pool, q } from '../db.js';
import { httpError, slugify } from './util.js';
import { writePageBody } from './pageBody.js';
import { syncPageLinks } from './links.js';
import { generateKeyBetween } from './orderKey.js';
import { SNAPSHOT_VERSION, decodeTransferCode, remapDocumentIds } from './spaceTransfer.js';

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

// A snapshot is JSON held in memory on both ends; this is the ceiling on what
// this workspace will read off the wire before giving up.
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

// Long enough for a large snapshot over a slow link, short enough that a dead
// origin fails the request instead of holding a connection open.
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Private, loopback, link-local and other non-public ranges.
 *
 * The link-local block is called out because 169.254.169.254 is the reason this
 * check exists at all on every major cloud: it is an unauthenticated HTTP
 * endpoint serving instance credentials, reachable from any process that can
 * make an outbound request.
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(lower)) return true; // unique local
    // An IPv4-mapped address is an IPv4 address wearing a hat; unwrap it rather
    // than letting ::ffff:169.254.169.254 through the IPv6 branch.
    //
    // Both spellings have to be handled: a caller may write the dotted form,
    // but the URL parser normalises it to hextets, so `http://[::ffff:169.254.
    // 169.254]` arrives here as `::ffff:a9fe:a9fe`. Matching only the readable
    // one would leave the metadata address reachable through its own canonical
    // spelling.
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hextets = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hextets) {
      const hi = parseInt(hextets[1], 16);
      const lo = parseInt(hextets[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true;
}

/**
 * Self-hosted workspaces genuinely do live beside each other on a LAN, so
 * private addresses are not forbidden outright — they are opt-in. An admin who
 * wants to import from `http://wiki.lan:3000` sets this and knows why.
 */
const privateHostsAllowed = () =>
  /^(1|true|yes)$/i.test(String(process.env.SPACE_IMPORT_ALLOW_PRIVATE_HOSTS || '').trim());

/**
 * Resolve the origin's host and refuse it if it points anywhere private.
 *
 * Returns the resolved addresses so the caller can pin the connection to what
 * was checked. Resolving and then fetching by name would leave a DNS-rebinding
 * window between the two, where the name resolves publicly for the check and
 * privately for the request.
 */
export async function assertPublicOrigin(origin) {
  const url = new URL(origin);
  // URL.hostname keeps the brackets on an IPv6 literal (`[fd00::1]`), and
  // net.isIP does not recognise them — without stripping, every literal v6
  // address falls through to a DNS lookup that cannot resolve it, and the
  // private-range check never runs on the one form most likely to be reaching
  // for something internal.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (privateHostsAllowed()) return;

  const literal = net.isIP(host) ? [host] : [];
  let addresses = literal;
  if (!literal.length) {
    try {
      const records = await dns.lookup(host, { all: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw httpError(400, `Could not reach ${host} — check the code and try again`);
    }
  }
  if (!addresses.length) throw httpError(400, `Could not reach ${host}`);
  if (addresses.some(isPrivateAddress)) {
    throw httpError(
      400,
      `${host} resolves to a private address. If that workspace really is on this network, ` +
        'set SPACE_IMPORT_ALLOW_PRIVATE_HOSTS=true on this server.'
    );
  }
}

/**
 * Pull the snapshot the code points at.
 *
 * Everything that comes back is another workspace's data, and this one has no
 * say in what it contains — so the size is capped while reading rather than
 * after, and the shape is validated before a single row is written.
 */
export async function fetchSnapshot(code) {
  // decodeTransferCode throws a message written for the person who pasted it.
  let parsed;
  try {
    parsed = decodeTransferCode(code);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const { origin, secret } = parsed;
  await assertPublicOrigin(origin);

  const url = `${origin}/api/export/${encodeURIComponent(secret)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // A redirect would land somewhere the origin check never saw, which is
      // exactly the hole the check exists to close.
      redirect: 'error',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw httpError(504, `${origin} did not respond in time`);
    throw httpError(502, `Could not reach ${origin} — is that workspace online?`);
  }

  try {
    if (res.status === 404) {
      throw httpError(400, 'That import code is not valid, or it has been revoked or expired');
    }
    if (!res.ok) throw httpError(502, `${origin} refused the import code (${res.status})`);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_SNAPSHOT_BYTES) {
      throw httpError(413, 'That export is too large to import');
    }

    const text = await readCapped(res, MAX_SNAPSHOT_BYTES);
    let snapshot;
    try {
      snapshot = JSON.parse(text);
    } catch {
      throw httpError(502, `${origin} did not return a Diomedes export`);
    }
    return validateSnapshot(snapshot, origin);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body, aborting as soon as it exceeds the cap. */
async function readCapped(res, limit) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw httpError(413, 'That export is too large to import');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Check the payload is the shape this version writes rows from, before any of
 * it is written. A partially imported space is worse than a refused import.
 */
export function validateSnapshot(snapshot, origin = 'that workspace') {
  if (!snapshot || typeof snapshot !== 'object') {
    throw httpError(502, `${origin} did not return a Diomedes export`);
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw httpError(
      400,
      `That export was made by a different version of Diomedes (format ${snapshot.version}, this workspace reads ${SNAPSHOT_VERSION})`
    );
  }
  if (!Array.isArray(snapshot.pages) || !snapshot.pages.length) {
    throw httpError(400, 'That export contains no pages');
  }
  for (const page of snapshot.pages) {
    if (!page || typeof page.id !== 'string') {
      throw httpError(502, `${origin} returned a malformed export`);
    }
  }
  return snapshot;
}

/**
 * Write a snapshot into a brand-new space.
 *
 * A new space rather than a merge into an existing one: the pages arrive with
 * ids from somewhere else, and there is no honest way to decide whether an
 * incoming page is an update to one already here or a different page that
 * happens to share a title. Importing into its own space makes the result
 * something the admin can look at, and delete in one action if it is wrong.
 *
 * The whole write is one transaction. An import that fails halfway would leave
 * a space holding an arbitrary prefix of someone else's tree.
 */
export async function importSnapshot({ snapshot, userId, name, icon }) {
  const spaceName = String(name || snapshot.space?.name || 'Imported space').trim().slice(0, 120);
  const spaceIcon = String(icon || snapshot.space?.icon || '📚');
  const description = String(snapshot.space?.description || '');

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');

    let slug = slugify(spaceName);
    const { rows: taken } = await conn.query('SELECT 1 FROM spaces WHERE slug = $1', [slug]);
    if (taken.length) slug = `${slug}-${Date.now().toString(36)}`;

    const { rows: spaceRows } = await conn.query(
      `INSERT INTO spaces (name, slug, description, icon, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [spaceName, slug, description, spaceIcon, userId]
    );
    const space = spaceRows[0];
    await conn.query(
      `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
      [space.id, userId]
    );

    // Pass one: create every page with its final parent, so the tree exists
    // before any body is written. Bodies reference page ids, and a link can
    // point forward as easily as backward — a one-pass write would be unable to
    // remap a reference to a page it has not created yet.
    const idMap = new Map();
    // Sibling order keys are regenerated rather than copied. The source keys
    // are valid, but only against the source's siblings; a placeholder whose
    // siblings were left behind would carry a key with gaps that mean nothing
    // here, and generating fresh ones keeps the order without the baggage.
    const nextKey = new Map();
    const rewritten = [];

    for (const page of snapshot.pages) {
      const parentId = page.parentId ? idMap.get(page.parentId) ?? null : null;
      const bucket = parentId ?? 'root';
      const orderKey = generateKeyBetween(nextKey.get(bucket) ?? null, null);
      nextKey.set(bucket, orderKey);

      const { rows } = await conn.query(
        `INSERT INTO pages (space_id, parent_id, title, icon, order_key, content, text_content,
                            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, '', $7, $7)
         RETURNING id`,
        [
          space.id,
          parentId,
          String(page.title || ''),
          String(page.icon || ''),
          orderKey,
          JSON.stringify(EMPTY_DOC),
          userId,
        ]
      );
      idMap.set(page.id, rows[0].id);
      if (page.includeContent && page.content) rewritten.push({ page, newId: rows[0].id });
    }

    // Pass two: bodies, with every reference to an exported page pointed at its
    // new id. writePageBody projects blocks and the tsvector in the same
    // transaction, so an imported page is searchable the moment it exists.
    for (const { page, newId } of rewritten) {
      const content = remapDocumentIds(page.content, idMap, slug);
      await writePageBody({ pageId: newId, content, userId, conn });
    }

    await conn.query('COMMIT');

    // Link rows are derived data and are rebuilt outside the transaction: a
    // backlink that lands a moment late is a cosmetic delay, and doing it
    // inside would hold the space's rows locked for the length of the import.
    for (const { newId } of rewritten) {
      const { rows } = await q('SELECT content FROM pages WHERE id = $1', [newId]);
      if (rows[0]) await syncPageLinks(newId, rows[0].content, space.id).catch(() => {});
    }

    return {
      space: { ...space, my_role: 'admin' },
      imported: {
        pages: snapshot.pages.length,
        withContent: rewritten.length,
        placeholders: snapshot.pages.length - rewritten.length,
      },
    };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
