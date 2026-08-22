// A space out and back in again, against a real postgres.
//
// The unit suite covers the rules in isolation; what it cannot cover is the
// part that only exists once rows are involved — that buildSnapshot reads back
// exactly what the frozen selection named, that importSnapshot rebuilds the
// tree with parents before children, and that a link between two exported pages
// comes out the other side pointing at the imported copy rather than at an id
// belonging to a workspace that is not there.
import assert from 'node:assert/strict';
import { q, pool, migrate } from '../../src/db.js';
import { generateKeyBetween } from '../../src/lib/orderKey.js';
import {
  buildSnapshot,
  createExportKey,
  resolveExportKey,
  revokeExportKey,
} from '../../src/lib/spaceExport.js';
import { importSnapshot } from '../../src/lib/spaceImport.js';
import { decodeTransferCode } from '../../src/lib/spaceTransfer.js';

const ok = (label) => console.log(`  ok  ${label}`);

await migrate();

const stamp = Date.now();
const { rows: users } = await q(
  `INSERT INTO users (username, name, password_hash, role) VALUES ($1,'Transfer','x','owner') RETURNING id`,
  [`transfer-${stamp}`]
);
const userId = users[0].id;

const { rows: spaces } = await q(
  `INSERT INTO spaces (name, slug, icon, description, created_by)
   VALUES ('Handbook',$1,'📘','The source space',$2) RETURNING id`,
  [`handbook-${stamp}`, userId]
);
const spaceId = spaces[0].id;

// root
//   guide          <- ticked
//     appendix     <- ticked, links to `guide`
//   secret         <- never ticked, and never an ancestor of anything ticked
const mk = async (title, parentId, prev, content) => {
  const { rows } = await q(
    `INSERT INTO pages (space_id, parent_id, title, icon, order_key, content, created_by, updated_by)
     VALUES ($1,$2,$3,'📄',$4,$5::jsonb,$6,$6) RETURNING id`,
    [
      spaceId,
      parentId,
      title,
      generateKeyBetween(prev, null),
      JSON.stringify(content ?? { type: 'doc', content: [{ type: 'paragraph' }] }),
      userId,
    ]
  );
  return rows[0].id;
};

const rootId = await mk('Root', null, null);
const guideId = await mk('Guide', rootId, null);
const secretId = await mk('Secret', rootId, 'a0');
const appendixId = await mk('Appendix', guideId, null, {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'pageLink', attrs: { pageId: guideId, label: 'Guide' } },
        { type: 'text', text: ' and ' },
        { type: 'pageLink', attrs: { pageId: secretId, label: 'Secret' } },
      ],
    },
  ],
});

// ---- minting ----

const { code, key } = await createExportKey({
  spaceId,
  userId,
  name: 'Berlin workspace',
  pageIds: [guideId, appendixId],
  expiresInDays: 30,
  origin: 'https://source.example.com',
});

assert.equal(key.contentCount, 2, 'two pages were ticked');
assert.equal(key.pageCount, 3, 'plus Root, carried for structure');
ok('minting freezes the ticked pages and their unticked ancestor');

const parsed = decodeTransferCode(code);
assert.equal(parsed.origin, 'https://source.example.com');
ok('the code round-trips back to the origin it was minted for');

const { rows: stored } = await q('SELECT key_hash, selection FROM space_export_keys WHERE id = $1', [key.id]);
assert.ok(!code.includes(stored[0].key_hash), 'the stored value is a hash, not the code');
assert.equal(stored[0].selection.length, 3);
ok('only the hash of the secret is stored');

// ---- redeeming ----

const resolved = await resolveExportKey(parsed.secret);
assert.equal(resolved.id, key.id);
ok('the secret resolves to its key');

const snapshot = await buildSnapshot(resolved);
assert.equal(snapshot.space.name, 'Handbook');
assert.deepEqual(
  snapshot.pages.map((p) => p.title),
  ['Root', 'Guide', 'Appendix'],
  'document order, parents before children'
);
assert.equal(snapshot.pages[0].includeContent, false, 'Root is a placeholder');
assert.equal(snapshot.pages[0].content, null, 'a placeholder carries no body at all');
assert.ok(snapshot.pages[1].content, 'Guide carries its body');
assert.ok(
  !snapshot.pages.some((p) => p.title === 'Secret'),
  'a page that was never ticked and is nobody’s ancestor does not travel'
);
ok('the snapshot carries the selection and nothing else');

// ---- importing ----

const { space: imported, imported: counts } = await importSnapshot({
  snapshot,
  userId,
  name: `Handbook copy ${stamp}`,
});

assert.equal(counts.pages, 3);
assert.equal(counts.withContent, 2);
assert.equal(counts.placeholders, 1);
ok('the import reports what it wrote');

const { rows: newPages } = await q(
  `SELECT id, parent_id, title, content FROM pages WHERE space_id = $1 AND deleted_at IS NULL ORDER BY title`,
  [imported.id]
);
assert.equal(newPages.length, 3);

const byTitle = Object.fromEntries(newPages.map((p) => [p.title, p]));
assert.equal(byTitle.Guide.parent_id, byTitle.Root.id, 'Guide still hangs off Root');
assert.equal(byTitle.Appendix.parent_id, byTitle.Guide.id, 'Appendix still hangs off Guide');
assert.equal(byTitle.Root.parent_id, null);
ok('the tree shape survives the trip');

// The placeholder exists so the tree holds together, and carries no content.
const rootText = JSON.stringify(byTitle.Root.content);
assert.ok(!rootText.includes('pageLink'), 'the placeholder body is empty');
ok('the placeholder is a title, not a copy of the page');

const links = JSON.stringify(byTitle.Appendix.content);
assert.ok(links.includes(byTitle.Guide.id), 'the link to Guide points at the imported Guide');
assert.ok(!links.includes(guideId), 'and no longer at the source workspace’s id');
assert.ok(links.includes(secretId), 'the link to a page outside the export keeps its original id');
ok('links between exported pages are repointed; links outside it are left alone');

// Blocks are projected in the same transaction, so an imported page is
// searchable the moment it exists rather than after its next save.
const { rows: blocks } = await q('SELECT count(*)::int AS n FROM page_blocks WHERE page_id = $1', [
  byTitle.Appendix.id,
]);
assert.ok(blocks[0].n > 0, 'imported pages have their blocks projected');
ok('imported pages are indexed on arrival');

// ---- revocation ----

await revokeExportKey(spaceId, key.id);
await assert.rejects(() => resolveExportKey(parsed.secret), /not valid/);
ok('a revoked key stops resolving');

// A wrong secret is refused the same way a revoked one is, so an
// unauthenticated caller cannot tell a real key from a guess.
await assert.rejects(() => resolveExportKey('a'.repeat(43)), /not valid/);
ok('an unknown secret is refused with the same message');

// ---- cleanup ----

await q('DELETE FROM spaces WHERE id = ANY($1::uuid[])', [[spaceId, imported.id]]);
await q('DELETE FROM users WHERE id = $1', [userId]);
await pool.end();
console.log('space transfer integration: all assertions passed');
