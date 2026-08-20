// The one-shot claim that converts a page's stored JSON into its CRDT.
//
// Not part of the test suite (that one must run without a database): the whole
// question here is what a single conditional UPDATE does against real rows.
//
// The bug this file exists for showed up after a bulk import. Every imported
// page had a body in `pages.content` and no CRDT yet, and opening one made a
// client claim the seed, say it had done it, and — if it was torn down before
// the text left the browser — leave the page marked `collab_seeded` with an
// empty CRDT. Nothing could ever seed it again, so it opened blank forever. The
// claim therefore asks for the evidence (a persisted ydoc) rather than for the
// flag.
import { q, pool, migrate } from '../../src/db.js';
import { generateKeyBetween } from '../../src/lib/orderKey.js';
import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ok  ${label}`);

const SEED_LEASE_SEC = 15; // mirrors routes/pages.js

/** The claim-seed statement, verbatim from routes/pages.js. */
const claim = async (pageId) => {
  const { rows } = await q(
    `UPDATE pages SET collab_seed_claimed_at = now()
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM page_ydoc y WHERE y.page_id = pages.id)
       AND (collab_seed_claimed_at IS NULL
            OR collab_seed_claimed_at < now() - ($2 || ' seconds')::interval)
     RETURNING id`,
    [pageId, SEED_LEASE_SEC]
  );
  return rows.length > 0;
};

const confirm = (pageId) => q('UPDATE pages SET collab_seeded = true WHERE id = $1', [pageId]);

/** Pretend the room flushed: the page now has a CRDT on disk. */
const flush = (pageId) =>
  q(
    `INSERT INTO page_ydoc (page_id, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (page_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [pageId, Buffer.from([1, 2, 3])]
  );

await migrate();

const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ('seed-e2e','Seed','x','owner') RETURNING id`
);
const userId = users[0].id;
const { rows: spaces } = await q(
  `INSERT INTO spaces (name, slug, created_by) VALUES ('Seed','seed-e2e',$1) RETURNING id`,
  [userId]
);
const spaceId = spaces[0].id;

let at = null;
const newPage = async (title) => {
  at = generateKeyBetween(at, null);
  const { rows } = await q(
    `INSERT INTO pages (space_id, title, order_key, created_by, updated_by, content, text_content)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, $6) RETURNING id`,
    [
      spaceId,
      title,
      at,
      userId,
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] }),
      title,
    ]
  );
  return rows[0].id;
};

// ---- a batch of imported pages: every one of them is seedable ----
{
  const ids = [];
  for (const n of [1, 2, 3, 4]) ids.push(await newPage(`Imported ${n}`));
  for (const id of ids) {
    assert.equal(await claim(id), true, 'an imported page could not be seeded');
    await confirm(id);
    await flush(id);
  }
  ok('every page of a batch import can be seeded, not just the first');

  for (const id of ids) {
    assert.equal(await claim(id), false, 'a page with a CRDT was seeded a second time');
  }
  ok('a page that really has a CRDT is never seeded again');
}

// ---- the case that used to be terminal ----
{
  const id = await newPage('Claimed and lost');
  assert.equal(await claim(id), true);
  // The client said it seeded and then went away without the text ever
  // reaching the server, so there is no ydoc row.
  await confirm(id);
  const { rows: state } = await q('SELECT collab_seeded FROM pages WHERE id = $1', [id]);
  assert.equal(state[0].collab_seeded, true, 'the flag is still recorded');

  // Inside the lease the claim is held, exactly as before.
  assert.equal(await claim(id), false);

  // Once it expires, the next client picks the page up — instead of the page
  // being blank for good because `collab_seeded` said the job was done.
  await q(
    `UPDATE pages SET collab_seed_claimed_at = now() - ($2 || ' seconds')::interval WHERE id = $1`,
    [id, SEED_LEASE_SEC + 1]
  );
  assert.equal(await claim(id), true, 'a page marked seeded with no CRDT is stranded blank');
  ok('a seed that was claimed, reported and lost is picked up again once the lease expires');
}

// ---- two clients opening the same fresh page ----
{
  const id = await newPage('Contended');
  assert.equal(await claim(id), true);
  assert.equal(await claim(id), false, 'two clients seeded the same page at once');
  ok('the claim is still exclusive for the length of its lease');
}

await q('DELETE FROM page_ydoc WHERE page_id IN (SELECT id FROM pages WHERE space_id = $1)', [spaceId]);
await q('DELETE FROM pages WHERE space_id = $1', [spaceId]);
await q('DELETE FROM spaces WHERE id = $1', [spaceId]);
await q('DELETE FROM users WHERE id = $1', [userId]);

console.log('\nall collab seed checks passed');
await pool.end();
