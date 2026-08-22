// What getPage() puts on the wire, against a real postgres.
//
// Not part of the unit suite (that one must run without a database). It needs
// one because the thing under test is a column list, and the only authority on
// what columns `pages` has is the table itself.
//
// Two failures are in scope, and they pull in opposite directions:
//
//   1. `text_content` or `tsv` coming back. They are search artifacts, nothing
//      reads them off a getPage() result, and a `SELECT *` used to ship both to
//      the browser on every page open -- the document three times over. See #86.
//
//   2. The list going stale. `PAGE_COLUMNS` is written out by hand because
//      Postgres has no `SELECT * EXCEPT`, so a migration that adds a column to
//      `pages` and forgets this list drops that column from every getPage()
//      caller silently. Comparing against information_schema is what turns that
//      silence into a failing test.
import { q, pool, migrate } from '../../src/db.js';
import { getPage } from '../../src/lib/auth.js';
import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ok  ${label}`);

// Deliberately not imported from auth.js. The point is to state the exclusions
// independently of the code that implements them -- importing the same constant
// the module uses would make the test agree with any change to it.
const EXCLUDED = ['text_content', 'tsv'];

await migrate();

const stamp = Date.now();
const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ($1,'Columns','x','owner') RETURNING id`,
  [`columns-${stamp}`]
);
const userId = users[0].id;
const { rows: spaces } = await q(
  `INSERT INTO spaces (name, slug, created_by) VALUES ('Columns',$1,$2) RETURNING id`,
  [`columns-${stamp}`, userId]
);
const spaceId = spaces[0].id;

// text_content is written explicitly so the assertions below are about the
// column list and not about the row happening to be empty there.
const { rows: pages } = await q(
  `INSERT INTO pages (space_id, title, content, text_content, order_key, created_by, updated_by)
   VALUES ($1,'Wire Weight',$2,$3,'a0',$4,$4) RETURNING id`,
  [
    spaceId,
    JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the quick brown fox' }] }],
    }),
    'the quick brown fox',
    userId,
  ]
);
const pageId = pages[0].id;

// tsv is maintained by the search path rather than a trigger, so set it here.
// A null tsv would let the exclusion assertion pass for the wrong reason.
await q(`UPDATE pages SET tsv = to_tsvector('english', text_content) WHERE id = $1`, [pageId]);

{
  const { rows } = await q(`SELECT text_content, tsv FROM pages WHERE id = $1`, [pageId]);
  assert.equal(rows[0].text_content, 'the quick brown fox', 'fixture did not store text_content');
  assert.ok(rows[0].tsv, 'fixture did not store a tsv');
  ok('the fixture row really does carry both of the columns under test');
}

const page = await getPage(pageId);

{
  for (const column of EXCLUDED) {
    assert.ok(
      !(column in page),
      `getPage() returned ${column}; it is a server-side search artifact and must not reach a caller`
    );
  }
  ok('getPage() returns neither text_content nor tsv');
}

{
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'pages'`
  );
  const expected = rows
    .map((r) => r.column_name)
    .filter((name) => !EXCLUDED.includes(name))
    .sort();
  const actual = Object.keys(page).sort();

  const missing = expected.filter((name) => !actual.includes(name));
  assert.deepEqual(
    missing,
    [],
    `PAGE_COLUMNS in lib/auth.js is stale -- pages has ${missing.join(', ')} and getPage() does not return it`
  );
  assert.deepEqual(
    actual,
    expected,
    'getPage() returns exactly the pages columns minus the excluded two'
  );
  ok('getPage() returns every other column the table has, so the list has not gone stale');
}

{
  // The permission check most getPage() callers exist for has to keep working.
  assert.equal(page.space_id, spaceId, 'space_id is what ~20 call sites read for their access check');
  assert.equal(page.title, 'Wire Weight');
  assert.ok(page.content, 'content is what actually renders and must survive');
  ok('space_id, title and content all still come back');
}

await q('DELETE FROM pages WHERE id = $1', [pageId]);
await q('DELETE FROM spaces WHERE id = $1', [spaceId]);
await q('DELETE FROM users WHERE id = $1', [userId]);
await pool.end();
console.log('pageColumns integration ok');
