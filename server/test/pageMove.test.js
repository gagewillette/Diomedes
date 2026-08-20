import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingOrderKey, rewriteLinkSlugs } from '../src/lib/pageMove.js';
import { isOrderKey } from '../src/lib/orderKey.js';

const siblings = (...keys) => keys.map((order_key, i) => ({ id: `p${i}`, order_key }));

// ---- where a drop lands ----
//
// These used to assert around a `needsRenumber` flag and a respread fallback,
// both of which existed because float positions could genuinely run out of
// midpoints. Order keys cannot, so the fallback is gone and what is left to
// test is simply that a drop lands where it was aimed — including after far
// more drops into one gap than the float encoding could survive.

test('the first page in an empty list gets a valid key', () => {
  const key = siblingOrderKey([], 0);
  assert.ok(isOrderKey(key), key);
});

test('dropping at the front lands before the current first page', () => {
  assert.ok(siblingOrderKey(siblings('a1', 'a2'), 0) < 'a1');
});

test('dropping at the end lands after the current last page', () => {
  assert.ok(siblingOrderKey(siblings('a1', 'a2'), 2) > 'a2');
});

test('dropping between two pages lands strictly between them', () => {
  const key = siblingOrderKey(siblings('a1', 'a2'), 1);
  assert.ok(key > 'a1' && key < 'a2');
});

test('an index past the end of the list is clamped rather than leaving a hole', () => {
  assert.ok(siblingOrderKey(siblings('a1'), 99) > 'a1');
});

test('a negative index is clamped to the front', () => {
  assert.ok(siblingOrderKey(siblings('a1', 'a2'), -5) < 'a1');
});

// The float version of this test had to stop at twenty and a second test had
// to prove the renumbering fallback fired somewhere past fifty. There is no
// fallback to fire now, so the only interesting number is a big one.
test('two hundred drops into the same gap stay ordered, with no renumbering', () => {
  let list = siblings('a1', 'a2');
  for (let i = 0; i < 200; i++) {
    const key = siblingOrderKey(list, 1);
    assert.ok(key > list[0].order_key && key < list[1].order_key, `collapsed at drop ${i}`);
    list = [list[0], { id: `new${i}`, order_key: key }, ...list.slice(1)];
  }
});

test('a drop is always one row: the siblings are never rewritten', () => {
  const list = siblings('a1', 'a2', 'a3');
  const before = list.map((s) => s.order_key);
  siblingOrderKey(list, 1);
  assert.deepEqual(list.map((s) => s.order_key), before);
});

// ---- repairing the links that point at a moved page ----

const doc = (...content) => ({ type: 'doc', content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t) => ({ type: 'text', text: t });
const link = (attrs) => ({ type: 'pageLink', attrs });

test('a link into the moved subtree is repointed at the new space', () => {
  const before = doc(para(text('see '), link({ pageId: 'p1', label: 'Roadmap', spaceSlug: 'old' })));
  const { node, changed } = rewriteLinkSlugs(before, new Map([['p1', 'new']]));
  assert.equal(changed, true);
  assert.equal(node.content[0].content[1].attrs.spaceSlug, 'new');
  // The label and the id are the link's identity and must survive untouched.
  assert.equal(node.content[0].content[1].attrs.label, 'Roadmap');
  assert.equal(node.content[0].content[1].attrs.pageId, 'p1');
});

test('links are found however deeply they are nested', () => {
  const before = doc({
    type: 'bulletList',
    content: [{ type: 'listItem', content: [para(link({ pageId: 'p1', spaceSlug: 'old', label: 'x' }))] }],
  });
  const { node, changed } = rewriteLinkSlugs(before, new Map([['p1', 'new']]));
  assert.equal(changed, true);
  assert.equal(node.content[0].content[0].content[0].content[0].attrs.spaceSlug, 'new');
});

test('a document with nothing to fix is returned unchanged, not rebuilt', () => {
  const before = doc(para(text('plain'), link({ pageId: 'p9', spaceSlug: 'other', label: 'y' })));
  const { node, changed } = rewriteLinkSlugs(before, new Map([['p1', 'new']]));
  assert.equal(changed, false);
  assert.equal(node, before);
});

test('a link that already names the new space is left alone', () => {
  const before = doc(para(link({ pageId: 'p1', spaceSlug: 'new', label: 'y' })));
  const { changed } = rewriteLinkSlugs(before, new Map([['p1', 'new']]));
  assert.equal(changed, false);
});

test('unresolved links, which have no target, are not given one', () => {
  const before = doc(para(link({ pageId: null, spaceSlug: null, label: 'Not Written Yet' })));
  const { node, changed } = rewriteLinkSlugs(before, new Map([['p1', 'new']]));
  assert.equal(changed, false);
  assert.equal(node.content[0].content[0].attrs.spaceSlug, null);
});

test('only the page links move; ordinary links and mentions are untouched', () => {
  const before = doc(
    para(
      { type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { href: '/s/old/p/p1' } }] },
      { type: 'mention', attrs: { id: 'p1', label: 'Ada' } }
    )
  );
  const { changed } = rewriteLinkSlugs(before, new Map([['p1', 'new']]));
  assert.equal(changed, false);
});

test('several links in one document are all repaired in a single pass', () => {
  const before = doc(
    para(link({ pageId: 'p1', spaceSlug: 'old', label: 'a' })),
    para(link({ pageId: 'p2', spaceSlug: 'old', label: 'b' }), link({ pageId: 'p3', spaceSlug: 'keep', label: 'c' }))
  );
  const { node } = rewriteLinkSlugs(before, new Map([['p1', 'new'], ['p2', 'new']]));
  assert.equal(node.content[0].content[0].attrs.spaceSlug, 'new');
  assert.equal(node.content[1].content[0].attrs.spaceSlug, 'new');
  assert.equal(node.content[1].content[1].attrs.spaceSlug, 'keep');
});
