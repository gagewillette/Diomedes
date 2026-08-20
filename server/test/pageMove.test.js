import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingPosition, respreadPositions, rewriteLinkSlugs, POSITION_GAP } from '../src/lib/pageMove.js';

const siblings = (...positions) => positions.map((position, i) => ({ id: `p${i}`, position }));

// ---- where a drop lands ----

test('the first page in an empty list gets a position with room on both sides', () => {
  assert.deepEqual(siblingPosition([], 0), { position: POSITION_GAP, needsRenumber: false });
});

test('dropping at the front lands before the current first page', () => {
  const { position } = siblingPosition(siblings(1000, 2000), 0);
  assert.ok(position < 1000);
});

test('dropping at the end lands after the current last page', () => {
  const { position } = siblingPosition(siblings(1000, 2000), 2);
  assert.ok(position > 2000);
});

test('dropping between two pages lands strictly between them', () => {
  const { position, needsRenumber } = siblingPosition(siblings(1000, 2000), 1);
  assert.equal(needsRenumber, false);
  assert.ok(position > 1000 && position < 2000);
});

test('an index past the end of the list is clamped rather than leaving a hole', () => {
  const { position } = siblingPosition(siblings(1000), 99);
  assert.ok(position > 1000);
});

test('a negative index is clamped to the front', () => {
  const { position } = siblingPosition(siblings(1000, 2000), -5);
  assert.ok(position < 1000);
});

test('drops into the same gap keep their order, renumbering only once they must', () => {
  // Twenty consecutive drops into the identical slot — far past anything a
  // person does by hand — still resolve by halving, with no renumber.
  let list = siblings(1000, 2000);
  for (let i = 0; i < 20; i++) {
    const { position, needsRenumber } = siblingPosition(list, 1);
    assert.equal(needsRenumber, false, `renumber demanded after ${i} drops`);
    assert.ok(position > list[0].position && position < list[1].position);
    list = [list[0], { id: `new${i}`, position }, ...list.slice(1)];
  }
});

test('a gap halved past the limits of a double asks for a renumber and recovers', () => {
  let list = siblings(1000, 2000);
  let renumbers = 0;
  for (let i = 0; i < 60; i++) {
    let { position, needsRenumber } = siblingPosition(list, 1);
    if (needsRenumber) {
      renumbers += 1;
      list = respreadPositions(list.length).map((p, n) => ({ id: list[n].id, position: p }));
      ({ position } = siblingPosition(list, 1));
    }
    assert.ok(position > list[0].position && position < list[1].position, `collapsed at drop ${i}`);
    list = [list[0], { id: `new${i}`, position }, ...list.slice(1)];
  }
  assert.ok(renumbers > 0, 'the renumber path was never exercised');
});

test('neighbours too close to fit a value between them ask for a renumber', () => {
  const { needsRenumber } = siblingPosition(siblings(1000, 1000), 1);
  assert.equal(needsRenumber, true);
});

test('respreadPositions hands back an ascending, evenly spaced list', () => {
  assert.deepEqual(respreadPositions(3), [1000, 2000, 3000]);
  assert.deepEqual(respreadPositions(0), []);
});

test('a respread list can then accept the drop that demanded it', () => {
  const flat = siblings(1000, 1000, 1000);
  assert.equal(siblingPosition(flat, 1).needsRenumber, true);
  const spread = respreadPositions(flat.length).map((position, i) => ({ id: `p${i}`, position }));
  const { position, needsRenumber } = siblingPosition(spread, 1);
  assert.equal(needsRenumber, false);
  assert.ok(position > 1000 && position < 2000);
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
