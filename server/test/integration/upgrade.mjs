// Upgrade path: a database that already holds pages ordered by float
// `position` must come out the other side of migrate() with the same order
// expressed as order keys, and must not be renumbered again on restart.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Resolved from this file so the checkout can live anywhere.
const WT = fileURLToPath(new URL('../../..', import.meta.url));
const ok = (label) => console.log(`  ok  ${label}`);

// Build the pre-migration schema by running the *old* db.js from main, so this
// is the real previous schema rather than a hand-written approximation.
// Written inside the server package so `pg` resolves the same way it does for
// the real module.
const dir = join(WT, 'server', 'src', '__oldschema');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const oldDb = execSync(`git -C ${WT} show origin/main:server/src/db.js`, { encoding: 'utf8' });
const oldConfig = execSync(`git -C ${WT} show origin/main:server/src/search/config.js`, { encoding: 'utf8' });
writeFileSync(join(dir, 'db.js'), oldDb.replace("./search/config.js", "./config.js"));
writeFileSync(join(dir, 'config.js'), oldConfig);
const old = await import(join(dir, 'db.js'));
await old.migrate();
ok('the pre-migration schema from origin/main was applied');

// `pg` is resolved through the old module rather than imported here, so this
// script does not need to live inside the server package.
let pool = old.pool;
const q = (t, p) => pool.query(t, p);

const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ('up','Up','x','owner') RETURNING id`
);
const userId = users[0].id;
const mkSpace = async (slug) => {
  const { rows } = await q(`INSERT INTO spaces (name, slug, created_by) VALUES ($1,$1,$2) RETURNING id`, [slug, userId]);
  return rows[0].id;
};
const spaceA = await mkSpace('alpha');
const spaceB = await mkSpace('beta');

// Deliberately messy float positions, including two collided values — the
// exact end state the float encoding drifts into.
const seed = async (spaceId, parentId, titlesAndPositions) => {
  const ids = [];
  for (const [title, position] of titlesAndPositions) {
    const { rows } = await q(
      `INSERT INTO pages (space_id, parent_id, title, position, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [spaceId, parentId, title, position, userId]
    );
    ids.push(rows[0].id);
  }
  return ids;
};

const [rootA] = await seed(spaceA, null, [
  ['A first', 1000],
  ['A second', 1500],
  ['A third', 1500.0000001],
  ['A fourth', 9000],
]);
await seed(spaceA, rootA, [['child one', 10], ['child two', 20]]);
await seed(spaceB, null, [['B first', -5], ['B second', 0], ['B third', 3]]);

const orderBefore = async (spaceId, parentId) => {
  const { rows } = await q(
    `SELECT title FROM pages WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
     ORDER BY position, created_at`,
    [spaceId, parentId]
  );
  return rows.map((r) => r.title);
};
const before = {
  aRoot: await orderBefore(spaceA, null),
  aChild: await orderBefore(spaceA, rootA),
  bRoot: await orderBefore(spaceB, null),
};
// ---- the upgrade ----
const next = await import(join(WT, 'server', 'src', 'db.js'));
await next.migrate();
ok('migrate() upgraded a populated database');

await pool.end();
pool = next.pool;

{
  const { rows } = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_name='pages' AND column_name='position'`
  );
  assert.equal(rows.length, 0, 'the position column survived the migration');
  ok('pages.position is gone');
}

const orderAfter = async (spaceId, parentId) => {
  const { rows } = await q(
    `SELECT title, order_key FROM pages WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
     ORDER BY order_key`,
    [spaceId, parentId]
  );
  return rows;
};

for (const [label, spaceId, parentId, expected] of [
  ['space A root', spaceA, null, before.aRoot],
  ['space A children', spaceA, rootA, before.aChild],
  ['space B root', spaceB, null, before.bRoot],
]) {
  const rows = await orderAfter(spaceId, parentId);
  assert.deepEqual(rows.map((r) => r.title), expected, `${label} order changed`);
  assert.equal(new Set(rows.map((r) => r.order_key)).size, rows.length, `${label} has duplicate keys`);
  ok(`${label}: order preserved (${expected.join(' → ')})`);
}

// Sibling lists are numbered independently, so keys may repeat across groups —
// what must not happen is a repeat *within* one group, checked above.
{
  const keys = await orderAfter(spaceA, null);
  const rev = await q('SELECT DISTINCT rev FROM pages');
  assert.deepEqual(rev.rows.map((r) => Number(r.rev)), [0]);
  ok('existing pages start at rev 0, so nothing thinks it holds a newer copy');
  assert.ok(keys.every((k) => /^[a-zA-Z][0-9A-Za-z]*$/.test(k.order_key)));
}

// Restarting must not renumber a tree people have since rearranged.
{
  const snapshot = await orderAfter(spaceA, null);
  // Simulate a rearrangement after the upgrade.
  await q(`UPDATE pages SET order_key = 'zz' WHERE title = 'A first'`);
  await next.migrate();
  const after = await orderAfter(spaceA, null);
  assert.equal(after[after.length - 1].title, 'A first', 'a restart renumbered the tree');
  assert.notDeepEqual(after.map((r) => r.title), snapshot.map((r) => r.title));
  ok('a second migrate() leaves a rearranged tree alone');
}

await pool.end();
rmSync(dir, { recursive: true, force: true });
console.log('\nupgrade path verified');
