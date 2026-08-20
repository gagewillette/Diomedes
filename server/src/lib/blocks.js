// Turning a document into rows, and keeping those rows in step with it.
//
// `pages.content` is one opaque jsonb blob. Nothing outside the editor can say
// "this paragraph" about any part of it, because the only handle it offers is a
// position in an array that shifts whenever anything above it changes. This
// module gives every top-level block its own row, keyed by the stable id the
// client stamps on it (client/src/editor/blockId.js), so the rest of the system
// can talk about blocks instead of documents.
//
// ---- Which way round is the source of truth ----
//
// The original migration plan had `page_blocks` be authoritative and rebuilt
// `pages.content` from it on every write. That was written before realtime
// collaboration landed. It cannot hold now: since PR #13 the live source of
// truth for an open page is the Yjs CRDT in `page_ydoc`, and `pages.content` is
// a snapshot of it that one elected client writes back. Making `page_blocks`
// authoritative would put a second, weaker writer (last-write-wins over whole
// blocks) in competition with a CRDT that already merges correctly at character
// level — two sources of truth for the same text, and the worse one winning
// whenever the two disagreed.
//
// So the direction is inverted: `page_blocks` is a *projection*, derived from
// the document inside the same transaction that stores it. It is never written
// by anything except this module, and it is always exactly consistent with the
// `pages.content` committed alongside it.
//
// Nothing downstream loses by this. The projection still delivers:
//
//   * stable identity per block, for `page_chunks.source_block_ids` — a typo
//     fix re-embeds one or two chunks instead of the whole page,
//   * a per-block `rev`, so `GET /pages/:id/delta?since=` can answer "what
//     changed" without shipping the document,
//   * an order key per block, so a future block drag handle can reorder by
//     writing one row.
import crypto from 'node:crypto';
import { extractText } from './util.js';
import { generateKeyBetween, generateNKeysBetween, isOrderKey } from './orderKey.js';

export const BLOCK_ID_ATTR = 'blockId';

// Mirrors newBlockId() on the client. The server mints ids for documents that
// arrive without them — the MCP server, the REST API, an import — so a block
// written by a script is addressable exactly like one typed in the browser.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newBlockId(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(12);
  let random = '';
  for (const b of bytes) random += ALPHABET[b & 31];
  return `blk_${time}${random}`;
}

export const isBlockId = (value) => typeof value === 'string' && /^blk_[0-9A-HJKMNP-TV-Z]{22}$/.test(value);

/**
 * JSON with object keys in a fixed order, so the same block hashes the same way
 * however its JSON happened to be built.
 *
 * Without this, a document that round-tripped through a different serialiser
 * would hash differently despite being identical, and every block on the page
 * would look changed — re-embedding the lot, which is the exact cost this
 * migration exists to remove.
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/**
 * Content hash of one block.
 *
 * Truncated SHA-256 rather than the xxhash64 the plan named: this is a
 * change-detection hash, not a security or a distribution one, 64 bits is
 * ample against accidental collision, and `node:crypto` means no new
 * dependency for a hash computed a few times per keystroke-burst.
 */
export const hashBlock = (node) =>
  crypto.createHash('sha256').update(canonicalJSON(node)).digest('hex').slice(0, 16);

/**
 * Split a document into its top-level blocks, minting ids for any that lack
 * one.
 *
 * Returns the blocks *and* whether ids had to be added, because a document that
 * gained ids here has to be stored back with them — otherwise the next save
 * mints different ids for the same blocks and every block on the page looks
 * new.
 */
export function splitBlocks(content) {
  const nodes = Array.isArray(content?.content) ? content.content : [];
  const blocks = [];
  const seen = new Set();
  let stamped = false;

  const stampedNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    let id = node.attrs?.[BLOCK_ID_ATTR];
    // A duplicate is treated exactly like a missing id. It means the document
    // arrived with two blocks claiming one name — a copy/paste that bypassed
    // the editor — and letting it through would make one block permanently
    // shadow the other in page_blocks, which is keyed on (page_id, block_id).
    if (!isBlockId(id) || seen.has(id)) {
      id = newBlockId();
      stamped = true;
    }
    seen.add(id);
    const next = node.attrs?.[BLOCK_ID_ATTR] === id ? node : { ...node, attrs: { ...node.attrs, [BLOCK_ID_ATTR]: id } };
    blocks.push({
      blockId: id,
      type: typeof next.type === 'string' ? next.type : 'unknown',
      content: next,
      hash: hashBlock(next),
      text: extractText(next),
    });
    return next;
  });

  const document = stamped ? { ...content, content: stampedNodes } : content;
  return { blocks, document, stamped };
}

/**
 * Order keys for a block list, reusing what is already stored wherever the
 * stored key still sorts correctly.
 *
 * Rewriting every key on every save would work and would be much simpler, but
 * it would make each save touch every row of a long page, and it would move
 * blocks whose `rev` should not have changed — which is precisely the signal
 * the delta endpoint and the embedding queue read. So a key is kept unless
 * keeping it would break the ordering, and only the runs that actually need
 * new keys get them.
 */
export function assignOrderKeys(blocks, existing) {
  const keys = new Array(blocks.length);
  let prev = null;
  let i = 0;

  while (i < blocks.length) {
    const current = existing.get(blocks[i].blockId);
    if (isOrderKey(current) && (prev === null || current > prev)) {
      keys[i] = current;
      prev = current;
      i++;
      continue;
    }
    // A run of blocks that need fresh keys, ending at the first block whose
    // stored key can still be reused as the run's upper bound.
    let end = i;
    let next = null;
    while (end < blocks.length) {
      const candidate = existing.get(blocks[end].blockId);
      if (isOrderKey(candidate) && (prev === null || candidate > prev)) {
        next = candidate;
        break;
      }
      end++;
    }
    const count = end - i;
    const fresh =
      count === 1 ? [generateKeyBetween(prev, next)] : generateNKeysBetween(prev, next, count);
    for (let j = 0; j < count; j++) keys[i + j] = fresh[j];
    prev = fresh[count - 1];
    i = end;
  }
  return keys;
}

/**
 * Bring `page_blocks` into line with `content`, on the connection of an already
 * open transaction.
 *
 * Only rows that actually differ are written, and only those get the new `rev`
 * — a save that changed one paragraph leaves the other thirty-nine rows at the
 * revision they were last genuinely edited at. That is what lets a client ask
 * for everything since revision N and the embedding queue re-embed one chunk.
 *
 * Returns the ids that were touched, for both of those callers.
 */
export async function materializeBlocks(conn, { pageId, blocks, rev, userId = null }) {
  const { rows: existingRows } = await conn.query(
    'SELECT block_id, hash, order_key FROM page_blocks WHERE page_id = $1',
    [pageId]
  );
  const existingHash = new Map(existingRows.map((r) => [r.block_id, r.hash]));
  const existingKey = new Map(existingRows.map((r) => [r.block_id, r.order_key]));

  const orderKeys = assignOrderKeys(blocks, existingKey);
  const changed = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const hashSame = existingHash.get(block.blockId) === block.hash;
    const keySame = existingKey.get(block.blockId) === orderKeys[i];
    if (hashSame && keySame) continue;
    changed.push(block.blockId);
    await conn.query(
      `INSERT INTO page_blocks (page_id, block_id, type, content, text_content, order_key, hash, rev, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
       ON CONFLICT (page_id, block_id) DO UPDATE SET
         type = EXCLUDED.type, content = EXCLUDED.content, text_content = EXCLUDED.text_content,
         order_key = EXCLUDED.order_key, hash = EXCLUDED.hash, rev = EXCLUDED.rev,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [
        pageId,
        block.blockId,
        block.type,
        JSON.stringify(block.content),
        block.text,
        orderKeys[i],
        block.hash,
        rev,
        userId,
      ]
    );
  }

  const present = blocks.map((b) => b.blockId);
  const { rows: gone } = await conn.query(
    `DELETE FROM page_blocks WHERE page_id = $1 AND NOT (block_id = ANY($2::text[]))
     RETURNING block_id`,
    [pageId, present]
  );
  const removed = gone.map((r) => r.block_id);

  // A deleted block is a change to the page as much as an edited one: the
  // chunks it fed have to be rebuilt without it.
  return { changed, removed, touched: [...changed, ...removed] };
}

/**
 * Rebuild a document from its stored blocks.
 *
 * Not on the write path — `pages.content` is the stored document and this
 * projection is derived from it, not the other way round. This exists for the
 * delta endpoint and for verifying, in tests and in a repair script, that the
 * projection really does reconstruct what it was built from.
 */
export function documentFromBlocks(rows, { type = 'doc' } = {}) {
  return { type, content: rows.map((r) => r.content) };
}
