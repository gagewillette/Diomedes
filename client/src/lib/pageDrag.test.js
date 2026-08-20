import test from 'node:test';
import assert from 'node:assert/strict';
import { dropIntent } from './pageDrag.js';

const row = { top: 100, height: 30 };

test('the top edge of a row means "place it above this page"', () => {
  assert.equal(dropIntent(row, 102), 'before');
});

test('the bottom edge means "place it below this page"', () => {
  assert.equal(dropIntent(row, 128), 'after');
});

test('the middle of a row means "nest it inside this page"', () => {
  assert.equal(dropIntent(row, 115), 'inside');
});

test('the whole row resolves to exactly one intent, edge to edge', () => {
  const seen = new Set();
  for (let y = row.top; y <= row.top + row.height; y += 1) {
    const intent = dropIntent(row, y);
    assert.ok(['before', 'inside', 'after'].includes(intent), `no intent at ${y}`);
    seen.add(intent);
  }
  assert.deepEqual([...seen].sort(), ['after', 'before', 'inside']);
});

test('a short row still offers all three targets', () => {
  const tiny = { top: 0, height: 9 };
  assert.equal(dropIntent(tiny, 1), 'before');
  assert.equal(dropIntent(tiny, 4.5), 'inside');
  assert.equal(dropIntent(tiny, 8), 'after');
});
