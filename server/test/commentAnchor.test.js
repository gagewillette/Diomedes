import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnchor } from '../src/lib/commentAnchor.js';

test('a page-level comment has no anchor', () => {
  assert.equal(normalizeAnchor(null), null);
  assert.equal(normalizeAnchor(undefined), null);
});

test('a well-formed anchor is stored field for field', () => {
  assert.deepEqual(
    normalizeAnchor({ blockId: 'blk_A1', quote: 'the phrase', offset: 12, prefix: 'before ', suffix: ' after' }),
    { blockId: 'blk_A1', quote: 'the phrase', offset: 12, prefix: 'before ', suffix: ' after' },
  );
});

test('unknown fields are dropped rather than stored', () => {
  const stored = normalizeAnchor({ quote: 'hi', pageId: 'somewhere else', __proto__: { evil: true }, extra: 'x' });
  assert.deepEqual(Object.keys(stored).sort(), ['blockId', 'offset', 'prefix', 'quote', 'suffix']);
});

test('an anchor with no words is a page-level comment', () => {
  assert.equal(normalizeAnchor({ quote: '   ' }), null);
  assert.equal(normalizeAnchor({ quote: '' }), null);
  assert.equal(normalizeAnchor({ blockId: 'blk_A1' }), null, 'a block id alone anchors nothing');
  assert.equal(normalizeAnchor('not an object'), null);
  assert.equal(normalizeAnchor([{ quote: 'array' }]), null);
});

test('oversized fields are truncated, not rejected', () => {
  const anchor = normalizeAnchor({
    quote: 'q'.repeat(5000),
    prefix: 'p'.repeat(5000),
    suffix: 's'.repeat(5000),
    blockId: 'b'.repeat(500),
  });
  assert.equal(anchor.quote.length, 300);
  assert.equal(anchor.prefix.length, 32);
  assert.equal(anchor.suffix.length, 32);
  assert.equal(anchor.blockId.length, 64);
});

test('the prefix keeps the end and the suffix keeps the start', () => {
  // Both are context *adjacent to the quote*, so truncation has to cut from the
  // far side or the anchor loses the characters that do the disambiguating.
  const anchor = normalizeAnchor({ quote: 'q', prefix: `${'x'.repeat(40)}NEAR`, suffix: `NEAR${'x'.repeat(40)}` });
  assert.ok(anchor.prefix.endsWith('NEAR'));
  assert.ok(anchor.suffix.startsWith('NEAR'));
});

test('a nonsense offset becomes zero rather than a bad query', () => {
  assert.equal(normalizeAnchor({ quote: 'x', offset: -5 }).offset, 0);
  assert.equal(normalizeAnchor({ quote: 'x', offset: 'twelve' }).offset, 0);
  assert.equal(normalizeAnchor({ quote: 'x', offset: Infinity }).offset, 0);
  assert.equal(normalizeAnchor({ quote: 'x', offset: 7.9 }).offset, 7);
});

test('a non-string block id is dropped, leaving the quote to do the work', () => {
  assert.equal(normalizeAnchor({ quote: 'x', blockId: 42 }).blockId, null);
  assert.equal(normalizeAnchor({ quote: 'x', blockId: { id: 'nope' } }).blockId, null);
});
