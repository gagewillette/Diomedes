// Deep page hierarchies (issue #24), against a real postgres.
//
// Everything here needs a database and could not be faked with one: the depth
// checks are recursive CTEs, the cycle guard is an advisory lock held across a
// transaction, and the restore rule turns on `now()` being the transaction
// timestamp. A unit test can only assert the arithmetic in `assertDepthFits`
// (test/pageMove.test.js does); whether the numbers handed to it describe the
// tree that is actually there is this file's job.
import { q, pool, migrate } from '../../src/db.js';
import { movePage } from '../../src/lib/pageMove.js';
import { pageSubtree } from '../../src/lib/subtree.js';
import { restorePage } from '../../src/lib/pageRestore.js';
import { MAX_PAGE_DEPTH, pageLevel, subtreeHeight } from '../../src/lib/pageDepth.js';
import { generateKeyBetween } from '../../src/lib/orderKey.js';
import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ok  ${label}`);

await migrate();

const stamp = Date.now();
const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ($1,'Depth','x','owner') RETURNING id`,
  [`depth-${stamp}`]
);
const userId = users[0].id;

const makeSpace = async (label) => {
  const { rows } = await q(
    `INSERT INTO spaces (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [label, `${label}-${stamp}`, userId]
  );
  return rows[0].id;
};
const spaceId = await makeSpace('depth');
const otherSpaceId = await makeSpace('depth-other');

let n = 0;
const makePage = async (title, parentId = null, space = spaceId) => {
  const { rows } = await q(
    `INSERT INTO pages (space_id, parent_id, title, order_key, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [space, parentId, title, generateKeyBetween(null, null) + String(n++).padStart(3, '0'), userId]
  );
  return rows[0];
};
const getPage = async (id) => (await q('SELECT * FROM pages WHERE id = $1', [id])).rows[0];

/** A chain of `depth` pages, each the child of the last. Returns them top down. */
const makeChain = async (prefix, depth, parentId = null, space = spaceId) => {
  const chain = [];
  let parent = parentId;
  for (let i = 0; i < depth; i++) {
    const page = await makePage(`${prefix}-${i + 1}`, parent, space);
    chain.push(page);
    parent = page.id;
  }
  return chain;
};

// ---- measuring the tree ----

const chain = await makeChain('level', 6);

{
  for (const [i, page] of chain.entries()) {
    assert.equal(await pageLevel(page.id), i + 1, `level of ${page.title}`);
  }
  ok('pageLevel counts from 1 at the root, however far down the chain goes');
}

{
  assert.equal(await subtreeHeight(chain[0].id), 5);
  assert.equal(await subtreeHeight(chain[4].id), 1);
  assert.equal(await subtreeHeight(chain[5].id), 0);
  ok('subtreeHeight is how far the branch reaches below the page, 0 for a leaf');
}

{
  // A trashed branch is not in the way of a move: it is not rendered, not
  // exported and not reachable, so counting it would refuse moves for the sake
  // of pages nobody can see.
  const doomed = await makePage('trashed', chain[5].id);
  await q('UPDATE pages SET deleted_at = now() WHERE id = $1', [doomed.id]);
  assert.equal(await subtreeHeight(chain[5].id), 0);
  await q('DELETE FROM pages WHERE id = $1', [doomed.id]);
  ok('deleted descendants do not count toward a branch height');
}

// ---- a six-deep tree behaves ----

{
  const rows = await pageSubtree(chain[0].id);
  assert.deepEqual(rows.map((r) => r.title), chain.map((p) => p.title));
  ok('pageSubtree returns all six levels in document order');
}

{
  const { rows: crumbs } = await q(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, title, 0 AS depth FROM pages WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.title, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id
     ) SELECT title FROM up WHERE id <> $1 ORDER BY depth DESC`,
    [chain[5].id]
  );
  assert.deepEqual(crumbs.map((c) => c.title), chain.slice(0, 5).map((p) => p.title));
  ok('breadcrumbs walk the full ancestor chain of the deepest page');
}

// ---- moving at depth ----

{
  const branch = await makeChain('graft', 3);
  await movePage({ page: branch[0], parentId: chain[3].id });
  assert.equal(await pageLevel(branch[2].id), 7);
  const rows = await pageSubtree(chain[0].id);
  assert.ok(rows.some((r) => r.title === 'graft-3'), 'the grafted branch is in the subtree');
  ok('a three-deep branch moves under a level-4 page and lands at level 7');
}

{
  // The move the old cap made impossible in both directions at once: the parent
  // is a subpage, and the page being moved is carrying subpages of its own.
  const deep = await makeChain('nested', 2, chain[5].id);
  assert.equal(await pageLevel(deep[1].id), 8);
  ok('a page created under a level-6 page is at level 8 with its child');
}

// ---- the limit ----

{
  const long = await makeChain('deep', MAX_PAGE_DEPTH);
  assert.equal(await pageLevel(long[MAX_PAGE_DEPTH - 1].id), MAX_PAGE_DEPTH);

  const stray = await makePage('one too far');
  await assert.rejects(
    () => movePage({ page: stray, parentId: long[MAX_PAGE_DEPTH - 1].id }),
    (err) => err.status === 400 && /nested 20 levels deep/.test(err.message),
    'moving under the deepest allowed page should be refused'
  );

  // One level up there is still room, so the refusal is about the limit and not
  // about deep trees in general.
  await movePage({ page: stray, parentId: long[MAX_PAGE_DEPTH - 2].id });
  assert.equal(await pageLevel(stray.id), MAX_PAGE_DEPTH);
  ok('the depth limit refuses the level past it and allows the level at it');
}

{
  const tall = await makeChain('tall', 3);
  const room = await makeChain('room', MAX_PAGE_DEPTH - 1);
  // Under the second-deepest page of `room` the branch's own root fits — a page
  // may sit at level 19 — but its two descendants would run past the limit.
  await assert.rejects(
    () => movePage({ page: tall[0], parentId: room[MAX_PAGE_DEPTH - 2].id }),
    (err) => err.status === 400 && /nested 20 levels deep/.test(err.message)
  );
  // Three levels higher there is exactly enough room for all three of them.
  await movePage({ page: tall[0], parentId: room[MAX_PAGE_DEPTH - 4].id });
  assert.equal(await pageLevel(tall[2].id), MAX_PAGE_DEPTH);
  ok('the whole branch has to fit, not just the page being dragged');
}

// ---- cycles ----

{
  const cyc = await makeChain('cycle', 4);
  await assert.rejects(
    () => movePage({ page: cyc[0], parentId: cyc[3].id }),
    (err) => err.status === 400 && /inside itself/.test(err.message),
    'a page must not be moved under its own great-grandchild'
  );
  ok('moving a page into its own descendant is refused at any depth');
}

{
  // Two moves that are each individually legal and together make a cycle: A under
  // B's child while B goes under A's child. Each transaction validates against
  // the tree it read, and without the advisory lock both commit and the four
  // pages detach from the root into a ring.
  //
  // The pool has to be warm first, and that is not a detail — it is the whole
  // reason this test is worth having. `movePage` opens with `pool.connect()`, so
  // against a cold pool the first move gets the one idle connection instantly
  // while the second waits on a TCP connect and an auth round trip, by which
  // time the first has committed and the second reads a tree that already
  // includes it. The race passes for the wrong reason and the lock looks
  // unnecessary. A warm pool is also what a running server always has.
  const warm = await Promise.all([pool.connect(), pool.connect()]);
  for (const conn of warm) conn.release();

  const a = await makeChain('raceA', 2);
  const b = await makeChain('raceB', 2);

  const results = await Promise.allSettled([
    movePage({ page: a[0], parentId: b[1].id }),
    movePage({ page: b[0], parentId: a[1].id }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1, 'exactly one of two cycle-forming moves may commit');

  // The assertion that actually matters is not "one failed" but "the tree is
  // still a tree": every one of the four pages still reaches a root by walking
  // parents. In a ring the walk comes back to where it started, which the cycle
  // guard in `pageLevel` turns into a level count with no root at the top of it.
  for (const page of [a[0], a[1], b[0], b[1]]) {
    const { rows } = await q(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, ARRAY[id] AS path FROM pages WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_id, up.path || p.id FROM pages p JOIN up ON p.id = up.parent_id
         WHERE NOT (p.id = ANY(up.path))
       ) SELECT count(*)::int AS n FROM up WHERE parent_id IS NULL`,
      [page.id]
    );
    assert.equal(rows[0].n, 1, `${page.title} no longer reaches the root — the tree has a cycle`);
  }
  ok('two concurrent moves cannot commit a cycle — one is refused, the tree holds');
}

// ---- delete and restore of a deep branch ----

const trashSubtree = (rootId) =>
  q(
    `WITH RECURSIVE sub AS (
       SELECT id FROM pages WHERE id = $1
       UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
     ) UPDATE pages SET deleted_at = now() WHERE id IN (SELECT id FROM sub)`,
    [rootId]
  );

{
  const doomed = await makeChain('trash', 5);
  await trashSubtree(doomed[0].id);
  const { rows: gone } = await q(
    'SELECT count(*)::int AS n FROM pages WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL',
    [doomed.map((p) => p.id)]
  );
  assert.equal(gone[0].n, 5, 'the whole branch went to the trash');

  const restored = await restorePage(await getPage(doomed[0].id));
  assert.equal(restored.length, 5, 'the whole branch came back');
  const rows = await pageSubtree(doomed[0].id);
  assert.deepEqual(rows.map((r) => r.title), doomed.map((p) => p.title));
  ok('restoring a five-deep branch brings back every page in it');
}

{
  // A page deleted on its own earlier is not part of the later deletion and must
  // stay in the trash when its parent is restored.
  const branch = await makeChain('mixed', 3);
  await q('UPDATE pages SET deleted_at = now() WHERE id = $1', [branch[2].id]);
  await trashSubtree(branch[0].id);

  await restorePage(await getPage(branch[0].id));
  assert.equal((await getPage(branch[0].id)).deleted_at, null);
  assert.equal((await getPage(branch[1].id)).deleted_at, null);
  assert.notEqual(
    (await getPage(branch[2].id)).deleted_at,
    null,
    'a page trashed separately beforehand should stay trashed'
  );
  ok('restore brings back one deletion, not everything that was ever under the page');
}

// ---- cross-space ----

{
  const branch = await makeChain('cross', 4);
  const result = await movePage({ page: branch[0], parentId: null, spaceId: otherSpaceId });
  assert.equal(result.movedIds.length, 4);
  const { rows: landed } = await q(
    'SELECT count(*)::int AS n FROM pages WHERE id = ANY($1::uuid[]) AND space_id = $2',
    [branch.map((p) => p.id), otherSpaceId]
  );
  assert.equal(landed[0].n, 4, 'every page in the branch changed space');
  assert.equal(await pageLevel(branch[3].id), 4, 'the shape of the branch survived the move');
  ok('a four-deep branch moves to another space with its whole subtree');
}

await pool.end();
console.log('depth: all good');
