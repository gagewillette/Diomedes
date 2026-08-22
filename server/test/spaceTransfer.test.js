import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTransferCode,
  encodeTransferCode,
  expandSelection,
  remapDocumentIds,
  remapHref,
  summarizeSelection,
} from '../src/lib/spaceTransfer.js';

// A small tree, written the way it renders:
//   root-a          (a0)
//     child-a1      (a0)
//     child-a2      (a1)
//       grand-a2a   (a0)
//   root-b          (a1)
const TREE = [
  { id: 'root-a', parent_id: null, order_key: 'a0' },
  { id: 'child-a1', parent_id: 'root-a', order_key: 'a0' },
  { id: 'child-a2', parent_id: 'root-a', order_key: 'a1' },
  { id: 'grand-a2a', parent_id: 'child-a2', order_key: 'a0' },
  { id: 'root-b', parent_id: null, order_key: 'a1' },
];

const ids = (selection) => selection.map((s) => s.id);
const content = (selection) => selection.filter((s) => s.includeContent).map((s) => s.id);

test('selecting a parent and its children carries all of them with content', () => {
  const selection = expandSelection(TREE, ['root-a', 'child-a1', 'child-a2', 'grand-a2a']);
  assert.deepEqual(ids(selection), ['root-a', 'child-a1', 'child-a2', 'grand-a2a']);
  assert.equal(selection.every((s) => s.includeContent), true);
});

test('selecting only the parent carries just the parent', () => {
  const selection = expandSelection(TREE, ['root-a']);
  assert.deepEqual(ids(selection), ['root-a']);
  assert.deepEqual(content(selection), ['root-a']);
});

test('selecting only a child carries the parent as a structural placeholder', () => {
  // The point of the whole feature: the tree shape survives, the unticked
  // parent's body does not travel.
  const selection = expandSelection(TREE, ['child-a1']);
  assert.deepEqual(ids(selection), ['root-a', 'child-a1']);
  assert.deepEqual(content(selection), ['child-a1']);
  assert.equal(selection.find((s) => s.id === 'root-a').includeContent, false);
});

test('a deep selection carries every ancestor, not just the immediate parent', () => {
  const selection = expandSelection(TREE, ['grand-a2a']);
  assert.deepEqual(ids(selection), ['root-a', 'child-a2', 'grand-a2a']);
  assert.deepEqual(content(selection), ['grand-a2a']);
});

test('selection comes back in document order, parents before their subtrees', () => {
  // Fed in an order that is neither document order nor the input order, to show
  // the walk is what establishes the ordering.
  const selection = expandSelection(TREE, ['root-b', 'grand-a2a', 'child-a1']);
  assert.deepEqual(ids(selection), ['root-a', 'child-a1', 'child-a2', 'grand-a2a', 'root-b']);
});

test('siblings keep order_key order, not insertion order', () => {
  const shuffled = [TREE[2], TREE[4], TREE[0], TREE[3], TREE[1]];
  const selection = expandSelection(shuffled, ['child-a1', 'child-a2', 'root-b']);
  assert.deepEqual(ids(selection), ['root-a', 'child-a1', 'child-a2', 'root-b']);
});

test('ids that are not in the space are ignored rather than invented', () => {
  const selection = expandSelection(TREE, ['child-a1', 'not-a-page']);
  assert.deepEqual(ids(selection), ['root-a', 'child-a1']);
});

test('an empty selection carries nothing', () => {
  assert.deepEqual(expandSelection(TREE, []), []);
});

test('a parent cycle terminates instead of hanging', () => {
  // Not reachable through the UI, but a walk that can loop forever on bad data
  // is a denial of service on the export endpoint.
  const cyclic = [
    { id: 'x', parent_id: 'y', order_key: 'a0' },
    { id: 'y', parent_id: 'x', order_key: 'a0' },
  ];
  const selection = expandSelection(cyclic, ['x']);
  assert.equal(Array.isArray(selection), true);
});

test('summarizeSelection separates real pages from placeholders', () => {
  const selection = expandSelection(TREE, ['grand-a2a']);
  assert.deepEqual(summarizeSelection(selection), {
    total: 3,
    withContent: 1,
    placeholders: 2,
  });
});

// ---- codes ----

test('a code round-trips through encode and decode', () => {
  const code = encodeTransferCode('https://wiki.example.com', 'sEcReT-token_123');
  const parsed = decodeTransferCode(code);
  assert.equal(parsed.origin, 'https://wiki.example.com');
  assert.equal(parsed.secret, 'sEcReT-token_123');
});

test('the encoded origin never contains a dot, so splitting on dots is safe', () => {
  // base64url is chosen for exactly this reason; a host with dots in it must
  // not be able to add fields to the code.
  const code = encodeTransferCode('https://a.b.c.example.com:8443', 'tok');
  assert.equal(code.split('.').length, 3);
  assert.equal(decodeTransferCode(code).origin, 'https://a.b.c.example.com:8443');
});

test('a port and a trailing path are normalised down to the origin', () => {
  const code = encodeTransferCode('https://wiki.example.com:3000/some/path/', 'tok');
  assert.equal(decodeTransferCode(code).origin, 'https://wiki.example.com:3000');
});

test('junk is refused with a message about not being a Diomedes code', () => {
  assert.throws(() => decodeTransferCode('hello world'), /not look like a Diomedes import code/);
  assert.throws(() => decodeTransferCode(''), /required/);
  assert.throws(() => decodeTransferCode('a.b'), /not look like a Diomedes import code/);
});

test('a code from a newer format says so instead of being called malformed', () => {
  const newer = `DIO9.${Buffer.from('https://x.example.com').toString('base64url')}.tok`;
  assert.throws(() => decodeTransferCode(newer), /newer version of Diomedes/);
});

test('a non-http origin is refused', () => {
  const bad = `DIO1.${Buffer.from('file:///etc/passwd').toString('base64url')}.tok`;
  assert.throws(() => decodeTransferCode(bad), /malformed/);
  const js = `DIO1.${Buffer.from('javascript:alert(1)').toString('base64url')}.tok`;
  assert.throws(() => decodeTransferCode(js), /malformed/);
});

test('a secret containing path characters is refused', () => {
  // Otherwise it would be pasted straight into the pull URL.
  const bad = `DIO1.${Buffer.from('https://x.example.com').toString('base64url')}.../../admin`;
  assert.throws(() => decodeTransferCode(bad), /not look like a Diomedes import code|malformed/);
});

// ---- id remapping ----

const OLD_A = '11111111-2222-4333-8444-555555555555';
const NEW_A = '99999999-8888-4777-8666-555555555555';
const OLD_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const idMap = new Map([[OLD_A, NEW_A]]);

test('a pageLink chip is repointed at the imported copy', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: OLD_A, label: 'Spec' } }] },
    ],
  };
  const out = remapDocumentIds(doc, idMap, 'imported-space');
  assert.equal(out.content[0].content[0].attrs.pageId, NEW_A);
  assert.equal(out.content[0].content[0].attrs.label, 'Spec');
});

test('a link to a page that was not exported is left alone, not blanked', () => {
  // A broken link is recoverable; a link silently pointing at the wrong page is
  // not, so anything outside the export keeps the id it had.
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: OLD_B } }] }],
  };
  const out = remapDocumentIds(doc, idMap, 'imported-space');
  assert.equal(out.content[0].content[0].attrs.pageId, OLD_B);
});

test('an in-app href is repointed and re-slugged', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see', marks: [{ type: 'link', attrs: { href: `/s/old-slug/p/${OLD_A}` } }] },
        ],
      },
    ],
  };
  const out = remapDocumentIds(doc, idMap, 'new-slug');
  assert.equal(out.content[0].content[0].marks[0].attrs.href, `/s/new-slug/p/${NEW_A}`);
});

test('remapHref leaves external urls and unknown pages untouched', () => {
  assert.equal(remapHref('https://example.com/docs', idMap, 'new'), 'https://example.com/docs');
  assert.equal(remapHref(`/s/old/p/${OLD_B}`, idMap, 'new'), `/s/old/p/${OLD_B}`);
});

test('remapping preserves the rest of the document exactly', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'a.b()' }] },
    ],
  };
  assert.deepEqual(remapDocumentIds(doc, idMap, 'new-slug'), doc);
});
