// Sidebar multi-select lives in the client, but which pages a ⌘-click or a
// shift-click ends up holding — and, above all, what order it holds them in —
// is behaviour rather than styling, so it is pinned here where the project
// actually runs tests. Same arrangement as vimNav.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dragPayload,
  inTreeOrder,
  nextSelection,
  treeOrder,
  visibleOrder,
} from '../../client/src/components/pageSelection.js';

// a, b, c at the top level; b has children b1 and b2.
const childrenOf = new Map([
  ['root', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]],
  ['b', [{ id: 'b1' }, { id: 'b2' }]],
]);
const order = treeOrder(childrenOf);
const openB = visibleOrder(childrenOf, new Set(['b']));
const closedB = visibleOrder(childrenOf, new Set());

const click = (state, id, mods = {}) =>
  nextSelection({ visible: openB, order, ...state, id, ...mods });

// ---- the two orders ----

test('tree order walks into children whether or not they are showing', () => {
  assert.deepEqual(order, ['a', 'b', 'b1', 'b2', 'c']);
});

test('visible order shows children only when the parent is open', () => {
  assert.deepEqual(closedB, ['a', 'b', 'c']);
  assert.deepEqual(openB, ['a', 'b', 'b1', 'b2', 'c']);
});

test('a selection is stored in tree order, not click order', () => {
  assert.deepEqual(inTreeOrder(order, ['c', 'a', 'b1']), ['a', 'b1', 'c']);
});

test('ids the tree no longer holds are dropped rather than carried along', () => {
  assert.deepEqual(inTreeOrder(order, ['a', 'gone', 'c']), ['a', 'c']);
});

// ---- clicking ----

test('a plain click clears the selection and drops the anchor there', () => {
  const after = click({ selected: ['a', 'b'], anchorId: 'a' }, 'c');
  assert.deepEqual(after.selected, []);
  assert.equal(after.anchorId, 'c');
});

test('⌘-click adds one page without disturbing the others', () => {
  const after = click({ selected: ['a'], anchorId: 'a' }, 'c', { meta: true });
  assert.deepEqual(after.selected, ['a', 'c']);
  assert.equal(after.anchorId, 'c');
});

test('⌘-click on an already selected page removes it', () => {
  const after = click({ selected: ['a', 'c'], anchorId: 'c' }, 'a', { meta: true });
  assert.deepEqual(after.selected, ['c']);
});

test('deselecting leaves the anchor where it was', () => {
  const after = click({ selected: ['a', 'c'], anchorId: 'c' }, 'a', { meta: true });
  assert.equal(after.anchorId, 'c');
});

test('⌘-clicking pages out of order still stores them in tree order', () => {
  let state = { selected: [], anchorId: null };
  for (const id of ['c', 'b1', 'a']) state = click(state, id, { meta: true });
  assert.deepEqual(state.selected, ['a', 'b1', 'c']);
});

// ---- shift ranges ----

test('shift-click selects everything between the anchor and the click', () => {
  const after = click({ selected: ['a'], anchorId: 'a' }, 'b2', { shift: true });
  assert.deepEqual(after.selected, ['a', 'b', 'b1', 'b2']);
});

test('a range selected upwards reads the same as one selected downwards', () => {
  const down = click({ selected: [], anchorId: 'a' }, 'c', { shift: true });
  const up = click({ selected: [], anchorId: 'c' }, 'a', { shift: true });
  assert.deepEqual(down.selected, up.selected);
});

test('the anchor stays put, so a second shift-click grows the same range', () => {
  const first = click({ selected: [], anchorId: 'a' }, 'b', { shift: true });
  assert.equal(first.anchorId, 'a');
  const second = click(first, 'b2', { shift: true });
  assert.deepEqual(second.selected, ['a', 'b', 'b1', 'b2']);
});

test('a shift range replaces the previous one rather than piling up', () => {
  const first = click({ selected: [], anchorId: 'a' }, 'b2', { shift: true });
  const second = click({ ...first, anchorId: 'b2' }, 'c', { shift: true });
  assert.deepEqual(second.selected, ['b2', 'c']);
});

test('⌘ plus shift gathers a second run without losing the first', () => {
  const first = click({ selected: [], anchorId: 'a' }, 'b', { shift: true });
  const second = click({ ...first, anchorId: 'b2' }, 'c', { meta: true, shift: true });
  assert.deepEqual(second.selected, ['a', 'b', 'b2', 'c']);
});

test('a range never reaches into a collapsed parent it stepped over', () => {
  const after = nextSelection({
    visible: closedB, order, selected: [], anchorId: 'a', id: 'c', shift: true,
  });
  assert.deepEqual(after.selected, ['a', 'b', 'c']);
});

test('shift with nowhere to measure from falls back to a plain click', () => {
  const after = click({ selected: ['a'], anchorId: null }, 'c', { shift: true });
  assert.deepEqual(after.selected, []);
  assert.equal(after.anchorId, 'c');
});

// ---- what a drag picks up ----

test('dragging a selected row carries the whole selection', () => {
  assert.deepEqual(dragPayload(['a', 'b1', 'c'], 'b1'), ['a', 'b1', 'c']);
});

test('dragging an unselected row carries only that row', () => {
  assert.deepEqual(dragPayload(['a', 'c'], 'b'), ['b']);
});

test('a selection of one is still a one-page drag', () => {
  assert.deepEqual(dragPayload(['a'], 'a'), ['a']);
});
