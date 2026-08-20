// End-to-end check of the block-storage write path against a real postgres.
//
// Not part of the test suite (that one must run without a database). This
// exercises migrate() plus every writer, and asserts the projection really is
// consistent with the document it was derived from.
import { q, pool, migrate } from '../../src/db.js';
import { writePageBody } from '../../src/lib/pageBody.js';
import { generateKeyBetween } from '../../src/lib/orderKey.js';
import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ok  ${label}`);

const doc = (...content) => ({ type: 'doc', content });
const para = (id, text) => ({
  type: 'paragraph',
  attrs: id ? { blockId: id } : {},
  content: [{ type: 'text', text }],
});

await migrate();
ok('migrate() ran on a fresh database');

// ---- collation is the thing most likely to be silently wrong ----
{
  const { rows } = await q(
    `SELECT c.collname FROM pg_attribute a
     JOIN pg_class t ON t.oid = a.attrelid
     LEFT JOIN pg_collation c ON c.oid = a.attcollation
     WHERE t.relname = 'pages' AND a.attname = 'order_key'`
  );
  assert.equal(rows[0].collname, 'C', `pages.order_key collation is ${rows[0].collname}, not C`);
  ok('pages.order_key is COLLATE "C"');

  const { rows: bc } = await q(
    `SELECT c.collname FROM pg_attribute a
     JOIN pg_class t ON t.oid = a.attrelid
     LEFT JOIN pg_collation c ON c.oid = a.attcollation
     WHERE t.relname = 'page_blocks' AND a.attname = 'order_key'`
  );
  assert.equal(bc[0].collname, 'C');
  ok('page_blocks.order_key is COLLATE "C"');

  // The actual behaviour, not just the declaration: under en_US.UTF-8 this
  // ordering comes back scrambled.
  await q(`CREATE TEMP TABLE ck (k text COLLATE "C")`);
  await q(`INSERT INTO ck VALUES ('a0'),('aZ'),('az'),('a9'),('A0')`);
  const { rows: sorted } = await q('SELECT k FROM ck ORDER BY k');
  assert.deepEqual(sorted.map((r) => r.k), ['A0', 'a0', 'a9', 'aZ', 'az']);
  ok('order keys sort in ASCII order in the database, matching generateKeyBetween');
}

// ---- fixtures ----
const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ('e2e','E2E','x','owner') RETURNING id`
);
const userId = users[0].id;
const { rows: spaces } = await q(
  `INSERT INTO spaces (name, slug, created_by) VALUES ('E2E','e2e',$1) RETURNING id`,
  [userId]
);
const spaceId = spaces[0].id;

// Mirrors what POST /pages does: append after the last sibling.
const makePage = async (title) => {
  const { rows: last } = await q(
    `SELECT order_key FROM pages WHERE space_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
     ORDER BY order_key DESC LIMIT 1`,
    [spaceId]
  );
  const { rows } = await q(
    `INSERT INTO pages (space_id, title, order_key, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id`,
    [spaceId, title, generateKeyBetween(last[0]?.order_key ?? null, null), userId]
  );
  return rows[0].id;
};

// ---- the projection ----
const pageId = await makePage('Projection');

const first = await writePageBody({
  pageId,
  content: doc(para('blk_AAAAAAAAAAAAAAAAAAAAAA', 'one'), para('blk_BBBBBBBBBBBBBBBBBBBBBB', 'two')),
  userId,
});
assert.equal(first.rev, 1);
assert.equal(first.changedBlockIds.length, 2);
ok('a first write projects both blocks and sets rev to 1');

{
  const { rows } = await q(
    'SELECT block_id, order_key, rev, text_content FROM page_blocks WHERE page_id = $1 ORDER BY order_key',
    [pageId]
  );
  assert.deepEqual(rows.map((r) => r.block_id), ['blk_AAAAAAAAAAAAAAAAAAAAAA', 'blk_BBBBBBBBBBBBBBBBBBBBBB']);
  assert.deepEqual(rows.map((r) => r.text_content), ['one', 'two']);
  assert.ok(rows[0].order_key < rows[1].order_key);
  ok('page_blocks reproduces the document order');
}

// Only the edited block changes, and only it takes the new rev.
const second = await writePageBody({
  pageId,
  content: doc(para('blk_AAAAAAAAAAAAAAAAAAAAAA', 'one'), para('blk_BBBBBBBBBBBBBBBBBBBBBB', 'two edited')),
  userId,
});
assert.equal(second.rev, 2);
assert.deepEqual(second.changedBlockIds, ['blk_BBBBBBBBBBBBBBBBBBBBBB']);
ok('editing one block reports exactly one changed id');

{
  const { rows } = await q('SELECT block_id, rev FROM page_blocks WHERE page_id = $1 ORDER BY order_key', [pageId]);
  assert.equal(Number(rows[0].rev), 1, 'the untouched block kept its revision');
  assert.equal(Number(rows[1].rev), 2);
  ok('the untouched block stays at the revision it was last really edited at');
}

// Resending an identical document costs nothing.
const third = await writePageBody({
  pageId,
  content: doc(para('blk_AAAAAAAAAAAAAAAAAAAAAA', 'one'), para('blk_BBBBBBBBBBBBBBBBBBBBBB', 'two edited')),
  userId,
});
assert.deepEqual(third.changedBlockIds, []);
ok('resending an unchanged document changes no blocks');

// Reordering: keys must be repaired, content must not be rewritten.
const fourth = await writePageBody({
  pageId,
  content: doc(para('blk_BBBBBBBBBBBBBBBBBBBBBB', 'two edited'), para('blk_AAAAAAAAAAAAAAAAAAAAAA', 'one')),
  userId,
});
{
  const { rows } = await q('SELECT block_id FROM page_blocks WHERE page_id = $1 ORDER BY order_key', [pageId]);
  assert.deepEqual(rows.map((r) => r.block_id), ['blk_BBBBBBBBBBBBBBBBBBBBBB', 'blk_AAAAAAAAAAAAAAAAAAAAAA']);
  assert.ok(fourth.changedBlockIds.length >= 1);
  ok('swapping two blocks reorders the projection');
}

// Deletion leaves a tombstone.
const fifth = await writePageBody({
  pageId,
  content: doc(para('blk_BBBBBBBBBBBBBBBBBBBBBB', 'two edited')),
  userId,
});
{
  const { rows } = await q('SELECT block_id, rev FROM page_block_tombstones WHERE page_id = $1', [pageId]);
  assert.deepEqual(rows.map((r) => r.block_id), ['blk_AAAAAAAAAAAAAAAAAAAAAA']);
  assert.equal(Number(rows[0].rev), fifth.rev);
  assert.ok(fifth.changedBlockIds.includes('blk_AAAAAAAAAAAAAAAAAAAAAA'));
  ok('deleting a block writes a tombstone at the deleting revision');
}

// And bringing it back clears the tombstone.
await writePageBody({
  pageId,
  content: doc(para('blk_BBBBBBBBBBBBBBBBBBBBBB', 'two edited'), para('blk_AAAAAAAAAAAAAAAAAAAAAA', 'restored')),
  userId,
});
{
  const { rows } = await q('SELECT block_id FROM page_block_tombstones WHERE page_id = $1', [pageId]);
  assert.equal(rows.length, 0);
  ok('a block that comes back clears its tombstone');
}

// A metadata-only write must not bump rev.
{
  const { rows: before } = await q('SELECT rev FROM pages WHERE id = $1', [pageId]);
  const meta = await writePageBody({ pageId, title: 'Renamed', userId });
  const { rows: after } = await q('SELECT rev, title FROM pages WHERE id = $1', [pageId]);
  assert.equal(Number(after[0].rev), Number(before[0].rev), 'a rename bumped rev');
  assert.equal(after[0].title, 'Renamed');
  assert.deepEqual(meta.changedBlockIds, []);
  ok('renaming a page does not bump rev or touch any block');
}

// ---- documents that arrive without ids (the API / MCP path) ----
{
  const apiPage = await makePage('From the API');
  const written = await writePageBody({
    pageId: apiPage,
    content: doc(para(null, 'written by a script'), para(null, 'second paragraph')),
    userId,
  });
  const { rows } = await q('SELECT block_id FROM page_blocks WHERE page_id = $1 ORDER BY order_key', [apiPage]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => /^blk_[0-9A-HJKMNP-TV-Z]{22}$/.test(r.block_id)));
  ok('a document with no block ids has them minted server-side');

  // Critically: the ids must have been stored back into pages.content, or the
  // next save mints new ones and every block looks changed.
  const { rows: stored } = await q('SELECT content FROM pages WHERE id = $1', [apiPage]);
  const storedIds = stored[0].content.content.map((n) => n.attrs.blockId);
  assert.deepEqual(storedIds.sort(), rows.map((r) => r.block_id).sort());
  ok('the minted ids are stored back into pages.content');

  const again = await writePageBody({ pageId: apiPage, content: stored[0].content, userId });
  assert.deepEqual(again.changedBlockIds, [], 'resaving remined ids and looked like a full rewrite');
  ok('resaving that document changes nothing — ids are stable across saves');
  assert.equal(written.changedBlockIds.length, 2);
}

// ---- duplicate ids arriving from outside the editor ----
{
  const dupPage = await makePage('Duplicates');
  await writePageBody({
    pageId: dupPage,
    content: doc(para('blk_CCCCCCCCCCCCCCCCCCCCCC', 'first'), para('blk_CCCCCCCCCCCCCCCCCCCCCC', 'second')),
    userId,
  });
  const { rows } = await q('SELECT block_id, text_content FROM page_blocks WHERE page_id = $1 ORDER BY order_key', [
    dupPage,
  ]);
  assert.equal(rows.length, 2, 'a duplicate id silently swallowed a block');
  assert.notEqual(rows[0].block_id, rows[1].block_id);
  assert.deepEqual(rows.map((r) => r.text_content), ['first', 'second']);
  ok('two blocks claiming one id are separated rather than one shadowing the other');
}

// ---- the projection reconstructs the document ----
{
  const { rows: page } = await q('SELECT content FROM pages WHERE id = $1', [pageId]);
  const { rows: blocks } = await q(
    'SELECT content FROM page_blocks WHERE page_id = $1 ORDER BY order_key',
    [pageId]
  );
  assert.deepEqual(
    { type: 'doc', content: blocks.map((b) => b.content) },
    page[0].content,
    'page_blocks does not reconstruct pages.content'
  );
  ok('the projection reconstructs pages.content exactly');
}

// ---- tree ordering under many drops into one gap ----
{
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await makePage(`tree ${i}`));
  // Repeatedly insert between the first two siblings, the case that breaks a
  // float encoding.
  for (let i = 0; i < 120; i++) {
    const { rows } = await q(
      `SELECT order_key FROM pages WHERE space_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
       ORDER BY order_key LIMIT 2`,
      [spaceId]
    );
    const key = generateKeyBetween(rows[0].order_key, rows[1].order_key);
    await q(
      `INSERT INTO pages (space_id, title, order_key, created_by, updated_by) VALUES ($1,$2,$3,$4,$4)`,
      [spaceId, `squeeze ${i}`, key, userId]
    );
  }
  const { rows } = await q(
    `SELECT order_key FROM pages WHERE space_id = $1 AND parent_id IS NULL AND deleted_at IS NULL ORDER BY order_key`,
    [spaceId]
  );
  const keys = rows.map((r) => r.order_key);
  assert.equal(new Set(keys).size, keys.length, 'two pages collided on one order key');
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
  ok(`120 drops into the same gap: ${keys.length} pages, all distinct and correctly ordered`);
}

console.log('\nall end-to-end schema checks passed');
await pool.end();
