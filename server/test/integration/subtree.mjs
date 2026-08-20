// The subtree query behind "export as ZIP", against a real postgres.
//
// Not part of the unit suite (that one must run without a database), and it
// really does need one: the whole point of the query is a recursive CTE, and a
// recursion that stops one level short cannot be caught by anything less.
//
// The trees here are built by writing parent_id directly, on purpose. That
// predates issue #24 — the fixture had to bypass a one-level cap the API would
// otherwise have enforced — and it is still the right call: this file is about
// the recursion in pageSubtree, and going through movePage would mix its depth
// checks into a test that is not about them. test/integration/depth.mjs covers
// the same trees built the way a user builds them.
import { q, pool, migrate } from '../../src/db.js';
import { pageSubtree } from '../../src/lib/subtree.js';
import { generateKeyBetween } from '../../src/lib/orderKey.js';
import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ok  ${label}`);

await migrate();

const stamp = Date.now();
const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ($1,'Subtree','x','owner') RETURNING id`,
  [`subtree-${stamp}`]
);
const userId = users[0].id;
const { rows: spaces } = await q(
  `INSERT INTO spaces (name, slug, created_by) VALUES ('Subtree',$1,$2) RETURNING id`,
  [`subtree-${stamp}`, userId]
);
const spaceId = spaces[0].id;

let n = 0;
const makePage = async (title, parentId = null) => {
  const { rows } = await q(
    `INSERT INTO pages (space_id, parent_id, title, order_key, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
    [spaceId, parentId, title, generateKeyBetween(null, null) + String(n++).padStart(3, '0'), userId]
  );
  return rows[0].id;
};

const titles = (rows) => rows.map((r) => r.title);

// ---- depth ----
const root = await makePage('Handbook');
const child = await makePage('Onboarding', root);
const grandchild = await makePage('Day One', child);
const greatGrandchild = await makePage('Hour One', grandchild);

{
  const rows = await pageSubtree(root);
  assert.deepEqual(
    titles(rows).sort(),
    ['Day One', 'Handbook', 'Hour One', 'Onboarding'],
    'the recursion stopped short of the deepest page'
  );
  ok('four levels come back from one query, however deep parent_id goes');
}

{
  const rows = await pageSubtree(child);
  assert.deepEqual(titles(rows).sort(), ['Day One', 'Hour One', 'Onboarding']);
  ok('exporting a child returns that child and only what is under it');
}

{
  const rows = await pageSubtree(greatGrandchild);
  assert.deepEqual(titles(rows), ['Hour One']);
  ok('a leaf returns just itself');
}

// ---- what must not come back ----
{
  const other = await makePage('Unrelated');
  await makePage('Also unrelated', other);
  const rows = await pageSubtree(root);
  assert.ok(!titles(rows).includes('Unrelated'));
  assert.ok(!titles(rows).includes('Also unrelated'));
  ok('a separate tree in the same space is not swept in');
}

{
  const trashed = await makePage('Deleted branch', child);
  const belowTrashed = await makePage('Below the deleted branch', trashed);
  await q('UPDATE pages SET deleted_at = now() WHERE id = $1', [trashed]);
  const rows = await pageSubtree(root);
  assert.ok(!titles(rows).includes('Deleted branch'), 'a trashed page was exported');
  assert.ok(
    !titles(rows).includes('Below the deleted branch'),
    'a live page under a trashed one was exported; the archive would claim it still exists'
  );
  ok('trashed pages are excluded, and so is everything beneath them');
}

{
  await q('UPDATE pages SET deleted_at = now() WHERE id = $1', [root]);
  const rows = await pageSubtree(root);
  assert.deepEqual(rows, [], 'a trashed page exported its whole subtree');
  await q('UPDATE pages SET deleted_at = NULL WHERE id = $1', [root]);
  ok('a trashed root exports nothing at all');
}

// ---- shape of the rows ----
{
  const [row] = await pageSubtree(root);
  assert.ok(!('content' in row), 'content came back unasked for; that is the expensive column');
  const [withContent] = await pageSubtree(root, { withContent: true });
  assert.ok('content' in withContent);
  assert.deepEqual(Object.keys(row).sort(), [
    'created_at', 'icon', 'id', 'order_key', 'parent_id', 'title', 'updated_at',
  ]);
  ok('content is fetched only when asked for; the rest is what the walk needs');
}

// ---- a cycle must not hang the query ----
{
  // parent_id has no constraint stopping this, and a recursive CTE with no
  // guard would spin until the connection died.
  await q('UPDATE pages SET parent_id = $1 WHERE id = $2', [greatGrandchild, root]);
  const rows = await pageSubtree(root);
  assert.equal(rows.length, 4);
  await q('UPDATE pages SET parent_id = NULL WHERE id = $1', [root]);
  ok('a parent cycle terminates instead of looping forever');
}

await q('DELETE FROM pages WHERE space_id = $1', [spaceId]);
await q('DELETE FROM spaces WHERE id = $1', [spaceId]);
await q('DELETE FROM users WHERE id = $1', [userId]);

console.log('\nall subtree checks passed');
await pool.end();
