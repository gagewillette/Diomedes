import test from 'node:test';
import assert from 'node:assert/strict';
import { assignOrderKeys, splitBlocks } from '../src/lib/blocks.js';
import { initialKeys, isOrderKey } from '../src/lib/orderKey.js';

/** A block list from ids alone — assignOrderKeys reads nothing else. */
const blocksOf = (...ids) => ids.map((blockId) => ({ blockId }));

/** The stored state of a page: every block in `ids`, keyed in that order. */
function stored(...ids) {
  const keys = initialKeys(ids.length);
  return new Map(ids.map((id, i) => [id, keys[i]]));
}

/** Which blocks came out with a key different from the one they went in with. */
const rewritten = (blocks, existing, keys) =>
  blocks.filter((b, i) => existing.get(b.blockId) !== keys[i]).map((b) => b.blockId);

const ascending = (keys) => keys.every((key, i) => i === 0 || keys[i - 1] < key);

test('an unchanged page rewrites nothing', () => {
  const blocks = blocksOf('a', 'b', 'c');
  const existing = stored('a', 'b', 'c');
  const keys = assignOrderKeys(blocks, existing);
  assert.deepEqual(rewritten(blocks, existing, keys), []);
});

test('a brand new page gets ascending keys', () => {
  const blocks = blocksOf('a', 'b', 'c');
  const keys = assignOrderKeys(blocks, new Map());
  assert.ok(keys.every(isOrderKey), keys.join(','));
  assert.ok(ascending(keys), keys.join(','));
});

test('a block dragged to the top rewrites exactly one key', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `b${i}`);
  const existing = stored(...ids);
  // The last block moves to the front — the case a greedy left-to-right pass
  // gets wrong, rewriting the other thirty-nine.
  const moved = [ids[39], ...ids.slice(0, 39)];
  const blocks = blocksOf(...moved);

  const keys = assignOrderKeys(blocks, existing);
  assert.ok(ascending(keys), keys.join(','));
  assert.deepEqual(rewritten(blocks, existing, keys), ['b39']);
});

test('a block dragged into the middle rewrites exactly one key', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const existing = stored(...ids);
  const blocks = blocksOf('a', 'e', 'b', 'c', 'd');

  const keys = assignOrderKeys(blocks, existing);
  assert.ok(ascending(keys), keys.join(','));
  assert.deepEqual(rewritten(blocks, existing, keys), ['e']);
  // The new key really does sort between its neighbours, which is the whole
  // point of the fractional encoding — no renumbering was needed to make room.
  assert.ok(keys[0] < keys[1] && keys[1] < keys[2]);
});

test('reversing a page keeps one key and rewrites the rest', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const existing = stored(...ids);
  const blocks = blocksOf('d', 'c', 'b', 'a');

  const keys = assignOrderKeys(blocks, existing);
  assert.ok(ascending(keys), keys.join(','));
  // Nothing better exists: no two of these blocks are still in their old
  // relative order, so the longest keepable run is one.
  assert.equal(rewritten(blocks, existing, keys).length, 3);
});

test('an inserted block takes a key between its neighbours', () => {
  const existing = stored('a', 'b');
  const blocks = blocksOf('a', 'new', 'b');

  const keys = assignOrderKeys(blocks, existing);
  assert.deepEqual(rewritten(blocks, existing, keys), ['new']);
  assert.ok(keys[0] < keys[1] && keys[1] < keys[2]);
});

test('a stored key that is not a valid order key is replaced', () => {
  const existing = new Map([['a', 'not a key'], ['b', initialKeys(1)[0]]]);
  const blocks = blocksOf('a', 'b');

  const keys = assignOrderKeys(blocks, existing);
  assert.ok(keys.every(isOrderKey), keys.join(','));
  assert.ok(ascending(keys), keys.join(','));
});

test('a hundred successive one-block drags never collapse the ordering', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
  let order = [...ids];
  let existing = stored(...ids);

  for (let round = 0; round < 100; round++) {
    // Repeatedly drop the last block between the first two: the move that
    // exhausts a float `position` column within about fifty rounds.
    order = [order[0], order[order.length - 1], ...order.slice(1, -1)];
    const blocks = blocksOf(...order);
    const keys = assignOrderKeys(blocks, existing);
    assert.ok(ascending(keys), `round ${round}: ${keys.join(',')}`);
    assert.equal(rewritten(blocks, existing, keys).length, 1, `round ${round}`);
    existing = new Map(order.map((id, i) => [id, keys[i]]));
  }
});

test('a reordered document keeps its block ids through splitBlocks', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { blockId: null }, content: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph', attrs: { blockId: null }, content: [{ type: 'text', text: 'two' }] },
    ],
  };
  const first = splitBlocks(doc);
  const [one, two] = first.blocks.map((b) => b.blockId);

  // The drag: same two nodes, swapped, ids intact — which is what the editor
  // produces, because the drop moves the node rather than re-parsing it.
  const dragged = { type: 'doc', content: [first.document.content[1], first.document.content[0]] };
  const after = splitBlocks(dragged);

  assert.deepEqual(after.blocks.map((b) => b.blockId), [two, one]);
  assert.equal(after.stamped, false); // no new ids: not a delete plus an insert
  // Same content hashes too, so only the order keys can differ.
  assert.deepEqual(
    after.blocks.map((b) => b.hash).sort(),
    first.blocks.map((b) => b.hash).sort()
  );
});
