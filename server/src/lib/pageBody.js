// The one place a page body is written.
//
// Storing a document now means three things that must agree with each other or
// not happen at all: the JSON in `pages.content`, the derived text and tsvector
// that full-text search reads, and the `page_blocks` projection. Splitting
// those across separate statements is how a page ends up with blocks that
// describe a document it no longer holds — invisible in the editor, wrong in
// search results, and wrong in whatever a cache had already fetched.
//
// So every writer goes through here, in one transaction: PATCH, page creation
// with a body, and version restore. The MCP server and any other API client
// reach it through PATCH without knowing this layer exists, which is the point
// — the legacy whole-body write keeps working and is internally converted into
// a block diff.
import { pool } from '../db.js';
import { extractText } from './util.js';
import { materializeBlocks, splitBlocks } from './blocks.js';

// Same expression the routes used inline, kept identical so the migration
// changes no search behaviour.
const tsv = (titleParam, textParam) =>
  `to_tsvector('english', left(coalesce(${titleParam},'') || ' ' || coalesce(${textParam},''), 500000))`;

/**
 * Write a document to a page and reproject its blocks.
 *
 * `conn` lets a caller that already has a transaction open (version restore,
 * which also has to clear the CRDT) join it rather than nest one.
 *
 * Returns the page's new `rev` and the ids of the blocks that actually changed
 * — the set the embedding queue re-embeds and the delta endpoint reports. A
 * save that touched one paragraph returns one id, whatever else is on the page.
 */
export async function writePageBody({ pageId, content, title, icon, userId, conn = null }) {
  const owned = !conn;
  const db = conn || (await pool.connect());
  try {
    if (owned) await db.query('BEGIN');

    // Serialises concurrent writers to this page. Without it two saves can
    // read the same block set, each diff against it, and each conclude the
    // other's blocks are gone.
    const { rows: locked } = await db.query(
      'SELECT id, title, icon, content, text_content, rev FROM pages WHERE id = $1 FOR UPDATE',
      [pageId]
    );
    const page = locked[0];
    if (!page) throw new Error(`page ${pageId} not found`);

    const changingBody = content !== undefined && content !== null;
    // A metadata-only write (a rename, an emoji) must not bump `rev`. Anything
    // watching revisions is watching the body; making a title change look like
    // a body change would have every cached client refetch a document that did
    // not move, and would re-embed a page whose text is unchanged.
    const rev = changingBody ? Number(page.rev) + 1 : Number(page.rev);

    let stored = page.content;
    let text = page.text_content;
    let touched = [];

    if (changingBody) {
      // Documents from the API, the MCP server or an import arrive with no
      // block ids. splitBlocks mints them, and `document` is the same document
      // with those ids in it — which is what has to be stored, or the next
      // save mints different ids for the same blocks and every block on the
      // page looks new.
      const { blocks, document } = splitBlocks(content);
      stored = document;
      text = extractText(document);
      const result = await materializeBlocks(db, { pageId, blocks, rev, userId });
      touched = result.touched;
      if (result.removed.length) {
        // A deletion cannot be discovered by a `WHERE rev > n` query, because
        // the evidence is a row that is no longer there. The tombstone is how
        // a client that missed this write learns to drop the block.
        await db.query(
          `INSERT INTO page_block_tombstones (page_id, block_id, rev)
           SELECT $1, unnest($2::text[]), $3
           ON CONFLICT (page_id, block_id) DO UPDATE SET rev = EXCLUDED.rev, deleted_at = now()`,
          [pageId, result.removed, rev]
        );
      }
      // A block coming back — an undo, a restore — must not stay tombstoned.
      if (blocks.length) {
        await db.query(
          'DELETE FROM page_block_tombstones WHERE page_id = $1 AND block_id = ANY($2::text[])',
          [pageId, blocks.map((b) => b.blockId)]
        );
      }
    }

    const newTitle = title !== undefined ? title : page.title;
    const { rows } = await db.query(
      `UPDATE pages SET title = $2, icon = COALESCE($3, icon), content = $4::jsonb, text_content = $5,
              tsv = ${tsv('$2', '$5')}, rev = $6, updated_by = $7, updated_at = now()
       WHERE id = $1
       RETURNING id, title, icon, rev, updated_at`,
      [pageId, newTitle, icon, JSON.stringify(stored), text, rev, userId]
    );

    if (owned) await db.query('COMMIT');
    return { page: rows[0], content: stored, changedBlockIds: touched, rev };
  } catch (err) {
    if (owned) await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (owned) db.release();
  }
}

/**
 * Project a page's blocks for the first time, for a page created with a body.
 *
 * Creation already inserts the document in one statement so the page is never
 * observable half-made; this reprojects from what was inserted rather than
 * duplicating that insert here.
 */
export async function projectNewPage({ pageId, content, userId, conn }) {
  const { blocks } = splitBlocks(content);
  return materializeBlocks(conn, { pageId, blocks, rev: 1, userId });
}
