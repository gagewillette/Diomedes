// The browser's copy of the export-selection rule. These cases deliberately
// mirror server/test/spaceTransfer.test.js: the two implementations exist so
// the modal can answer a tick without a round trip, and they are only useful
// while they agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree,
  descendantIds,
  placeholderIds,
  selectionSummary,
} from './spaceSelection.js';

const TREE = [
  { id: 'root-a', parent_id: null, order_key: 'a0' },
  { id: 'child-a1', parent_id: 'root-a', order_key: 'a0' },
  { id: 'child-a2', parent_id: 'root-a', order_key: 'a1' },
  { id: 'grand-a2a', parent_id: 'child-a2', order_key: 'a0' },
  { id: 'root-b', parent_id: null, order_key: 'a1' },
];

test('buildTree groups children under parents in order_key order', () => {
  const { children, roots } = buildTree(TREE);
  assert.deepEqual(roots.map((p) => p.id), ['root-a', 'root-b']);
  assert.deepEqual(children.get('root-a').map((p) => p.id), ['child-a1', 'child-a2']);
  assert.deepEqual(children.get('child-a2').map((p) => p.id), ['grand-a2a']);
});

test('buildTree is insensitive to the order pages arrive in', () => {
  const shuffled = [TREE[3], TREE[1], TREE[4], TREE[2], TREE[0]];
  const { children, roots } = buildTree(shuffled);
  assert.deepEqual(roots.map((p) => p.id), ['root-a', 'root-b']);
  assert.deepEqual(children.get('root-a').map((p) => p.id), ['child-a1', 'child-a2']);
});

test('descendantIds walks the whole branch, not just one level', () => {
  const { children } = buildTree(TREE);
  assert.deepEqual(descendantIds(children, 'root-a').sort(), ['child-a1', 'child-a2', 'grand-a2a']);
  assert.deepEqual(descendantIds(children, 'grand-a2a'), []);
});

test('an unticked parent of a ticked child is a placeholder', () => {
  const { byId } = buildTree(TREE);
  assert.deepEqual([...placeholderIds(byId, ['child-a1'])], ['root-a']);
});

test('every ancestor becomes a placeholder, not only the immediate parent', () => {
  const { byId } = buildTree(TREE);
  assert.deepEqual([...placeholderIds(byId, ['grand-a2a'])].sort(), ['child-a2', 'root-a']);
});

test('a ticked parent is not also counted as a placeholder', () => {
  const { byId } = buildTree(TREE);
  assert.deepEqual([...placeholderIds(byId, ['root-a', 'child-a1'])], []);
});

test('selecting only the parent needs no placeholders at all', () => {
  const { byId } = buildTree(TREE);
  assert.deepEqual(selectionSummary(byId, ['root-a']), {
    withContent: 1,
    placeholders: 0,
    total: 1,
  });
});

test('the summary matches what the server will freeze into the key', () => {
  // Same case as the server test "a deep selection carries every ancestor":
  // three pages travel, one of them with content.
  const { byId } = buildTree(TREE);
  assert.deepEqual(selectionSummary(byId, ['grand-a2a']), {
    withContent: 1,
    placeholders: 2,
    total: 3,
  });
});

test('ids that are not pages in this space are ignored', () => {
  const { byId } = buildTree(TREE);
  assert.deepEqual(selectionSummary(byId, ['child-a1', 'nonsense']), {
    withContent: 1,
    placeholders: 1,
    total: 2,
  });
});

test('an empty selection summarises to nothing', () => {
  const { byId } = buildTree(TREE);
  assert.deepEqual(selectionSummary(byId, []), { withContent: 0, placeholders: 0, total: 0 });
});

test('a parent cycle terminates instead of hanging', () => {
  const cyclic = [
    { id: 'x', parent_id: 'y', order_key: 'a0' },
    { id: 'y', parent_id: 'x', order_key: 'a0' },
  ];
  const { byId } = buildTree(cyclic);
  assert.equal(placeholderIds(byId, ['x']) instanceof Set, true);
});
