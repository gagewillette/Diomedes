// Vim navigation lives in the client, but the two rules that make it worth
// having — j/k reaching every page, { } ignoring children — are behaviour, not
// styling, so they are pinned here where the project actually runs tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenVisible,
  jumpParent,
  moveDown,
  moveUp,
} from '../../client/src/components/vimTreeNav.js';
import { isVimQuitAnswer, DEFAULT_PREFS } from '../../client/src/lib/prefs.js';

// A ─ A1 ─ A1a          B          C ─ C1
//   └ A2
const PAGES = [
  { id: 'A', parent_id: null }, { id: 'A1', parent_id: 'A' }, { id: 'A1a', parent_id: 'A1' },
  { id: 'A2', parent_id: 'A' }, { id: 'B', parent_id: null },
  { id: 'C', parent_id: null }, { id: 'C1', parent_id: 'C' },
];

function tree(pages = PAGES) {
  const childrenOf = new Map();
  for (const page of pages) {
    const key = page.parent_id || 'root';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(page);
  }
  return childrenOf;
}

test('only expanded branches are drawn', () => {
  const childrenOf = tree();
  assert.deepEqual(flattenVisible(childrenOf, new Set()).map((r) => r.id), ['A', 'B', 'C']);
  assert.deepEqual(
    flattenVisible(childrenOf, new Set(['A'])).map((r) => r.id),
    ['A', 'A1', 'A2', 'B', 'C']
  );
});

test('j reaches every page, opening parents on the way down', () => {
  const childrenOf = tree();
  let expanded = new Set();
  let cursor = null;
  const visited = [];
  for (let i = 0; i < 10; i += 1) {
    const move = moveDown(childrenOf, expanded, cursor);
    if (!move) break;
    expanded = new Set([...expanded, ...move.expand]);
    cursor = move.id;
    visited.push(cursor);
  }
  assert.deepEqual(visited, ['A', 'A1', 'A1a', 'A2', 'B', 'C', 'C1']);
});

test('k retraces the same path back up', () => {
  const childrenOf = tree();
  const expanded = new Set(['A', 'A1', 'C']);
  let cursor = 'C1';
  const visited = [];
  for (let i = 0; i < 10; i += 1) {
    const move = moveUp(childrenOf, expanded, cursor);
    if (!move) break;
    cursor = move.id;
    visited.push(cursor);
  }
  assert.deepEqual(visited, ['C', 'B', 'A2', 'A1a', 'A1', 'A']);
});

test('j steps into a collapsed parent rather than over it', () => {
  assert.deepEqual(moveDown(tree(), new Set(), 'A'), { id: 'A1', expand: ['A'] });
});

test('k opens the collapsed parent above and lands on its last child', () => {
  assert.deepEqual(moveUp(tree(), new Set(), 'B'), { id: 'A2', expand: ['A'] });
});

test('braces jump between top-level pages and ignore children', () => {
  const childrenOf = tree();
  assert.deepEqual(jumpParent(childrenOf, PAGES, 'A', 1), { id: 'B', expand: [] });
  // Deep inside A's subtree, } still lands on the next top-level page…
  assert.deepEqual(jumpParent(childrenOf, PAGES, 'A1a', 1), { id: 'B', expand: [] });
  // …and { comes back to the top of the subtree you are in.
  assert.deepEqual(jumpParent(childrenOf, PAGES, 'A1a', -1), { id: 'A', expand: [] });
  assert.deepEqual(jumpParent(childrenOf, PAGES, 'B', -1), { id: 'A', expand: [] });
  // Never opens anything: children stay as they were.
  for (const id of ['A', 'A1a', 'B', 'C']) {
    for (const dir of [1, -1]) {
      assert.deepEqual(jumpParent(childrenOf, PAGES, id, dir)?.expand ?? [], []);
    }
  }
});

test('movement stops at the ends of the tree', () => {
  const childrenOf = tree();
  assert.equal(moveDown(childrenOf, new Set(['C']), 'C1'), null);
  assert.equal(moveUp(childrenOf, new Set(), 'A'), null);
  assert.equal(jumpParent(childrenOf, PAGES, 'C', 1), null);
  assert.equal(moveDown(new Map(), new Set(), null), null);
});

test('with no cursor, movement starts from the nearest end', () => {
  const childrenOf = tree();
  assert.deepEqual(moveDown(childrenOf, new Set(), null), { id: 'A', expand: [] });
  assert.deepEqual(moveUp(childrenOf, new Set(), null), { id: 'C', expand: [] });
  assert.deepEqual(jumpParent(childrenOf, PAGES, null, 1), { id: 'A', expand: [] });
});

test('vim is off until someone answers the quit question', () => {
  assert.equal(DEFAULT_PREFS.keymap, 'default');
  for (const good of [':q!', 'q!', ' :Q! ', ':qa!', ':qall!', ':quit!', 'ZQ', 'zq']) {
    assert.equal(isVimQuitAnswer(good), true, `${good} should be accepted`);
  }
  // :q and :wq do not get you out of a modified buffer, and ZZ saves.
  for (const bad of [':q', 'q', ':wq', 'ZZ', '', null, undefined, 'quit', ':x!', 'esc']) {
    assert.equal(isVimQuitAnswer(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});
