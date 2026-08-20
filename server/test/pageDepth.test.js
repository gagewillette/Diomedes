// What the sidebar offers at depth. The client half of issue #24.
//
// The server refuses every illegal create and move regardless of what the client
// thinks (server/test/integration/depth.mjs pins that). What is only decidable
// here is what the sidebar *shows* — whether "New subpage" appears on a row,
// whether a drag shows the "no drop" cursor, how far a row is indented, and how
// a long breadcrumb chain folds. Those are behaviour rather than styling, so
// they are pinned here where the project actually runs tests. Same arrangement
// as pageSelection.test.js and vimNav.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREADCRUMB_LIMIT,
  MAX_PAGE_DEPTH,
  canBeNested,
  canNest,
  dropAllowed,
  elideCrumbs,
  rowIndent,
  subtreeIds,
  treeDepths,
} from '../../client/src/components/pageDepth.js';

// A chain of pages, each the child of the last, in the shape PageTree builds:
// parent id → children, with root pages under 'root'.
const chainTree = (depth, prefix = 'p') => {
  const map = new Map();
  for (let i = 0; i < depth; i++) {
    const key = i === 0 ? 'root' : `${prefix}${i - 1}`;
    map.set(key, [{ id: `${prefix}${i}`, title: `${prefix}-${i + 1}` }]);
  }
  return map;
};

// ---- measuring the tree ----

test('treeDepths numbers every page from 0 at the root', () => {
  const { depths } = treeDepths(chainTree(5));
  assert.deepEqual([...depths.entries()], [
    ['p0', 0],
    ['p1', 1],
    ['p2', 2],
    ['p3', 3],
    ['p4', 4],
  ]);
});

test('treeDepths reports how far each branch reaches below itself', () => {
  const { heights } = treeDepths(chainTree(5));
  assert.equal(heights.get('p0'), 4, 'the root of a five-page chain is four levels tall');
  assert.equal(heights.get('p3'), 1);
  assert.equal(heights.get('p4'), 0, 'a leaf has no height');
  assert.equal(heights.get('root'), 5, "'root' carries the height of the whole tree");
});

test('the height of a branch is its tallest arm, not its last one', () => {
  // A shallow sibling must not make a deep one look shallow, which is the shape
  // a Math.max written as an assignment gets wrong.
  const map = new Map([
    ['root', [{ id: 'a' }]],
    ['a', [{ id: 'deep' }, { id: 'shallow' }]],
    ['deep', [{ id: 'deeper' }]],
  ]);
  const { heights } = treeDepths(map);
  assert.equal(heights.get('a'), 2);
});

test('subtreeIds collects a page and everything under it', () => {
  const ids = subtreeIds(chainTree(4), 'p1');
  assert.deepEqual(ids.sort(), ['p1', 'p2', 'p3']);
});

test('subtreeIds of a leaf is just the leaf, so the picker still excludes it', () => {
  assert.deepEqual(subtreeIds(chainTree(3), 'p2'), ['p2']);
});

// ---- what the limit allows ----
//
// `depth` is 0-based, as PageTree's renderNode carries it, so the deepest legal
// row is at depth MAX_PAGE_DEPTH - 1.

const deepest = MAX_PAGE_DEPTH - 1;

test('a page can take subpages until there is no level left beneath it', () => {
  assert.ok(canNest(0), 'a root page');
  assert.ok(canNest(deepest - 1), 'one above the bottom still has room for a child');
  assert.ok(!canNest(deepest), 'the deepest row cannot take children');
});

test('a childless page can be nested until it would land past the limit', () => {
  assert.ok(canBeNested(0));
  assert.ok(canBeNested(deepest - 1), 'moving down one lands exactly at the limit');
  assert.ok(!canBeNested(deepest));
});

test('nesting a page carries its branch, so a tall one runs out sooner', () => {
  // The case the old rule stood in for by refusing outright: "a page with
  // subpages cannot itself become a subpage".
  assert.ok(canBeNested(deepest - 3, 2), 'the deepest page lands exactly at the limit');
  assert.ok(!canBeNested(deepest - 3, 3), 'one level taller and it does not fit');
});

test('dropping inside a row costs a level, dropping beside it does not', () => {
  assert.ok(!dropAllowed(deepest, 'inside'), 'inside the deepest row is a level too far');
  assert.ok(dropAllowed(deepest, 'before'), 'beside it is the same level, which is fine');
  assert.ok(dropAllowed(deepest, 'after'));
});

test('a drag is refused when the branch it carries would not fit', () => {
  // Both drops land the batch root at the same level; only the height differs.
  assert.ok(dropAllowed(deepest - 2, 'inside', 1));
  assert.ok(!dropAllowed(deepest - 2, 'inside', 2));
});

test('an ordinary drag near the top of the tree is always allowed', () => {
  assert.ok(dropAllowed(0, 'inside', 3));
  assert.ok(dropAllowed(2, 'before', 5));
});

// ---- indentation ----

test('indentation is a full step per level while the sidebar can afford it', () => {
  assert.equal(rowIndent(0), 4);
  assert.equal(rowIndent(1) - rowIndent(0), 14);
  assert.equal(rowIndent(5) - rowIndent(4), 14);
});

test('the step narrows past the first few levels instead of running off-screen', () => {
  assert.equal(rowIndent(6) - rowIndent(5), 4);
  assert.equal(rowIndent(19) - rowIndent(18), 4);
});

test('the deepest row still leaves most of a 260px sidebar for the title', () => {
  // The whole point of the taper. A flat 14px step would put this at 270px, off
  // the end of the sidebar entirely.
  assert.ok(rowIndent(deepest) < 140, `deepest row indents ${rowIndent(deepest)}px`);
});

test('indentation never decreases as the tree gets deeper', () => {
  for (let d = 1; d < MAX_PAGE_DEPTH; d++) {
    assert.ok(rowIndent(d) > rowIndent(d - 1), `depth ${d} is not deeper than ${d - 1}`);
  }
});

// ---- breadcrumbs ----

const crumbs = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `c${i}` }));
const titles = (list) => list.map((c) => c.title);

test('a short chain renders whole, with nothing behind a menu', () => {
  const { leading, elided, trailing } = elideCrumbs(crumbs(BREADCRUMB_LIMIT));
  assert.equal(elided.length, 0);
  assert.equal(trailing.length, 0);
  assert.equal(leading.length, BREADCRUMB_LIMIT);
});

test('a long chain keeps the first ancestor and the last two', () => {
  const { leading, elided, trailing } = elideCrumbs(crumbs(8));
  assert.deepEqual(titles(leading), ['c0']);
  assert.deepEqual(titles(elided), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(titles(trailing), ['c6', 'c7']);
});

test('eliding loses nothing — every ancestor is still reachable', () => {
  for (const n of [0, 1, 4, 5, 12, MAX_PAGE_DEPTH]) {
    const { leading, elided, trailing } = elideCrumbs(crumbs(n));
    assert.deepEqual(
      titles([...leading, ...elided, ...trailing]),
      titles(crumbs(n)),
      `a chain of ${n} came back different`
    );
  }
});

test('the fold starts one past the limit, not at it', () => {
  assert.equal(elideCrumbs(crumbs(BREADCRUMB_LIMIT)).elided.length, 0);
  // One crumb past the limit already folds two, because the fold always keeps
  // the first and the last two — there is no arrangement that hides exactly one.
  assert.equal(elideCrumbs(crumbs(BREADCRUMB_LIMIT + 1)).elided.length, 2);
});
