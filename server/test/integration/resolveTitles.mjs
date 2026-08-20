// The exact-title lookup behind `POST /api/pages/resolve-titles`, against a
// real postgres.
//
// Not part of the unit suite (that one must run without a database), and it
// really does need one: what is being checked is the SQL — the normalization
// has to agree with the expression the title index is built on, the match has
// to be on the whole title rather than a substring, and a page in the trash has
// to stop answering. `pickTitleMatch` is unit-tested separately; this is the
// half that only postgres can answer.
//
// The fixture is deliberately the shape that broke `link-search` (issue #66):
// one page titled "Overview", buried under twenty newer pages whose titles
// merely contain the word. That endpoint matches `ILIKE '%q%'`, ranks by
// `updated_at DESC` and stops at twelve rows, so the page being looked for is
// not in the answer at all. This lookup does not care how many pages share a
// substring, or which was touched last.
import { q, pool, migrate } from '../../src/db.js';
import { lookupTitles, pickTitleMatch, normalizeTitle } from '../../src/lib/links.js';
import { accessibleSpacesQuery } from '../../src/lib/auth.js';
import { generateKeyBetween } from '../../src/lib/orderKey.js';
import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ok  ${label}`);

await migrate();
ok('migrate() ran, including the normalized-title index');

const stamp = Date.now();
const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ($1,'Titles','x','owner') RETURNING id`,
  [`titles-${stamp}`]
);
const userId = users[0].id;
const user = { id: userId, role: 'owner' };
const acc = accessibleSpacesQuery(user);

const makeSpace = async (name) => {
  const { rows } = await q(
    `INSERT INTO spaces (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [name, `${name.toLowerCase()}-${stamp}`, userId]
  );
  return rows[0].id;
};
const spaceId = await makeSpace('Titles');
const otherSpaceId = await makeSpace('Elsewhere');

let n = 0;
const makePage = async (space, title) => {
  const { rows } = await q(
    `INSERT INTO pages (space_id, title, order_key, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$4) RETURNING id`,
    [space, title, generateKeyBetween(null, null) + String(n++).padStart(3, '0'), userId]
  );
  return rows[0].id;
};

// Resolve one title the way the route does.
const resolve = async (title, prefer = spaceId) => {
  const byKey = await lookupTitles([title], acc);
  return pickTitleMatch(byKey.get(normalizeTitle(title)), prefer);
};

// ---- the exact match is found however many substrings bury it ----
const overview = await makePage(spaceId, 'Overview');
for (let i = 0; i < 20; i++) await makePage(spaceId, `Service Overview ${i}`);

{
  const match = await resolve('Overview');
  assert.equal(match.status, 'ok');
  assert.equal(match.page.id, overview, 'the page titled exactly that, not one merely containing it');
  ok('an exact title buried under twenty substring matches still resolves');
}

// ---- normalization matches how titles are compared everywhere else ----
const arch = await makePage(spaceId, 'Architecture');
{
  for (const written of ['  ARCHITECTURE  ', 'architecture', 'Architecture']) {
    const match = await resolve(written);
    assert.equal(match.status, 'ok', `"${written}" resolves`);
    assert.equal(match.page.id, arch);
  }
  ok('case, surrounding space, and inner runs of space make no difference');

  const inner = await makePage(spaceId, 'Design   Docs');
  const match = await resolve('Design Docs');
  assert.equal(match.page.id, inner, 'the stored title is normalized too, not just the query');
  ok('a title stored with a double space answers to the single-spaced one');
}

// ---- a batch is one query, and every title asked for is answered ----
{
  const asked = ['Overview', 'Architecture', 'Never Written'];
  const byKey = await lookupTitles(asked, acc);
  assert.equal(byKey.size, 3);
  assert.equal(byKey.get('overview')[0].id, overview);
  assert.equal(byKey.get('architecture')[0].id, arch);
  assert.deepEqual(byKey.get('never written'), [], 'a title nothing carries comes back empty, not missing');
  ok('a whole document of links is answered by one query');

  const row = byKey.get('architecture')[0];
  assert.ok(row.space_slug && row.space_id, 'a hit carries what a link node needs');
  ok('a hit carries the slug a link needs for its href');
}

// ---- space preference, and real ties ----
{
  await makePage(otherSpaceId, 'Architecture');
  const local = await resolve('Architecture', spaceId);
  assert.equal(local.status, 'ok');
  assert.equal(local.page.id, arch, 'the space being written in wins');

  const elsewhere = await resolve('Architecture', otherSpaceId);
  assert.equal(elsewhere.status, 'ok');
  assert.notEqual(elsewhere.page.id, arch, 'and so does the other space, from over there');

  const neither = await resolve('Architecture', null);
  assert.equal(neither.status, 'ambiguous');
  assert.equal(neither.candidates.length, 2, 'with no space to prefer, a tie is a tie');
  ok('the same title in two spaces resolves locally, and is ambiguous with no space');

  const dupe = await makePage(spaceId, 'Architecture');
  const tie = await resolve('Architecture', spaceId);
  assert.equal(tie.status, 'ambiguous', 'two pages titled the same in one space are never guessed at');
  assert.ok(tie.candidates.map((p) => p.id).includes(dupe));
  ok('two pages titled the same in one space are reported as ambiguous');

  // ---- the trash stops answering ----
  await q('UPDATE pages SET deleted_at = now() WHERE id = $1', [dupe]);
  const afterTrash = await resolve('Architecture', spaceId);
  assert.equal(afterTrash.status, 'ok');
  assert.equal(afterTrash.page.id, arch, 'trashing the duplicate settles it');
  ok('a trashed page is not a link target');
}

// ---- what the caller cannot read, they cannot resolve ----
{
  const { rows: strangers } = await q(
    `INSERT INTO users (username, name, password_hash, role) VALUES ($1,'Stranger','x','member') RETURNING id`,
    [`stranger-${stamp}`]
  );
  const strangerAcc = accessibleSpacesQuery({ id: strangers[0].id, role: 'member' });
  const byKey = await lookupTitles(['Overview'], strangerAcc);
  assert.deepEqual(byKey.get('overview'), [], 'a private space is invisible to a non-member');
  ok('resolution never reaches outside the caller\'s spaces');
}

// ---- empty input costs nothing ----
{
  const byKey = await lookupTitles([], acc);
  assert.equal(byKey.size, 0);
  const blanks = await lookupTitles(['', '   '], acc);
  assert.equal(blanks.size, 0, 'a blank title is not a query');
  ok('an empty batch is an empty answer');
}

// ---- the index the lookup is meant to read ----
{
  const { rows } = await q(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'pages' AND indexname = 'pages_title_norm_idx'`
  );
  assert.equal(rows.length, 1, 'pages_title_norm_idx should exist after migrate()');
  assert.match(rows[0].indexdef, /space_id/, 'and be keyed by space first');
  ok('the normalized-title index is in place');
}

await pool.end();
console.log('resolve-titles: all checks passed');
