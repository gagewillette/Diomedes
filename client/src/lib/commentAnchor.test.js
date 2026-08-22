import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import {
  buildAnchor,
  flatten,
  indexAtPos,
  isValidAnchor,
  posAtIndex,
  quotePreview,
  resolveAll,
  resolveAnchor,
} from './commentAnchor.js';

// The same trick the other editor tests use: a bare schema rather than a booted
// TipTap editor, so the real ProseMirror walk runs with no DOM in sight. The
// `blockId` attribute is declared here because that is what the anchor keys on.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: { blockId: { default: null } } },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 }, blockId: { default: null } },
    },
    text: { group: 'inline' },
  },
  marks: { bold: {} },
});

const p = (blockId, ...text) =>
  schema.nodes.paragraph.create(
    { blockId },
    text.filter(Boolean).map((t) => (typeof t === 'string' ? schema.text(t) : t)),
  );
const bold = (t) => schema.text(t, [schema.marks.bold.create()]);
const doc = (...nodes) => schema.nodes.doc.create(null, nodes);

/** The text a resolved range actually covers — the assertion that matters. */
const textOf = (document, range) => (range ? document.textBetween(range.from, range.to) : null);

test('flatten maps every position in both directions', () => {
  const document = doc(p('blk_a', 'hello'), p('blk_b', 'world'));
  const flat = flatten(document, 0);
  assert.equal(flat.text, 'hello\nworld');

  for (const index of [0, 3, 5]) {
    assert.equal(indexAtPos(flat, posAtIndex(flat, index)), index);
  }
  // The separator is not a character in the document, so it has no position.
  assert.equal(posAtIndex(flat, 5), 6);
});

test('flatten walks across marks within one block', () => {
  const document = doc(p('blk_a', 'plain ', bold('bold'), ' tail'));
  const flat = flatten(document, 0);
  assert.equal(flat.text, 'plain bold tail');
  assert.equal(textOf(document, { from: posAtIndex(flat, 6), to: posAtIndex(flat, 10) }), 'bold');
});

test('buildAnchor captures quote, block and surrounding context', () => {
  const document = doc(p('blk_a', 'The quick brown fox jumps over the lazy dog'));
  // "brown fox" — position 1 is the first character of the paragraph.
  const from = 1 + 10;
  const anchor = buildAnchor(document, from, from + 9);

  assert.equal(anchor.quote, 'brown fox');
  assert.equal(anchor.blockId, 'blk_a');
  assert.equal(anchor.offset, 10);
  assert.equal(anchor.prefix, 'The quick ');
  assert.ok(anchor.suffix.startsWith(' jumps'));
});

test('buildAnchor refuses an empty or whitespace-only selection', () => {
  const document = doc(p('blk_a', 'word   word'));
  assert.equal(buildAnchor(document, 3, 3), null);
  assert.equal(buildAnchor(document, 5, 8), null, 'pure whitespace is not a phrase');
});

test('resolveAnchor finds the quote again in an unchanged document', () => {
  const document = doc(p('blk_a', 'The quick brown fox'));
  const anchor = buildAnchor(document, 11, 20);
  const range = resolveAnchor(document, anchor);

  assert.equal(range.exact, true);
  assert.equal(textOf(document, range), 'brown fox');
});

test('resolveAnchor survives edits elsewhere on the page', () => {
  const before = doc(p('blk_a', 'first'), p('blk_b', 'the important phrase here'));
  const anchor = buildAnchor(before, 12, 12 + 16);
  assert.equal(anchor.quote, 'important phrase');

  // A whole paragraph inserted above, and the first one rewritten at length:
  // every document position in the target block has moved.
  const after = doc(
    p('blk_new', 'a brand new opening paragraph'),
    p('blk_a', 'first, now considerably longer than it was'),
    p('blk_b', 'the important phrase here'),
  );
  const range = resolveAnchor(after, anchor);
  assert.equal(range.exact, true);
  assert.equal(textOf(after, range), 'important phrase');
});

test('resolveAnchor prefers the anchored block when the phrase repeats', () => {
  const before = doc(p('blk_a', 'see the note'), p('blk_b', 'see the note'));
  const anchor = buildAnchor(before, 15, 15 + 12);
  assert.equal(anchor.blockId, 'blk_b');

  const range = resolveAnchor(before, anchor);
  assert.equal(range.from, 15, 'resolved into blk_b, not the identical text in blk_a');
});

test('resolveAnchor uses context to disambiguate repeats inside one block', () => {
  const document = doc(p('blk_a', 'alpha target omega and again beta target gamma'));
  const second = 1 + 'alpha target omega and again beta '.length;
  const anchor = buildAnchor(document, second, second + 6);
  assert.equal(anchor.quote, 'target');

  const range = resolveAnchor(document, anchor);
  assert.equal(range.from, second, 'the second occurrence, the one that was selected');
});

test('resolveAnchor falls back to the text when the block is gone', () => {
  const before = doc(p('blk_a', 'a sentence with a claim in it'));
  const at = 1 + 'a sentence with a '.length;
  const anchor = buildAnchor(before, at, at + 5);
  assert.equal(anchor.quote, 'claim');

  // The paragraph was split in two, so the id the anchor names no longer exists.
  const after = doc(p('blk_x', 'a sentence with'), p('blk_y', 'a claim in it'));
  const range = resolveAnchor(after, anchor);

  assert.equal(range.exact, false, 'found, but not where it was left');
  assert.equal(textOf(after, range), 'claim');
});

test('resolveAnchor reports nothing when the text was deleted', () => {
  const before = doc(p('blk_a', 'this whole sentence goes away'));
  const at = 1 + 'this '.length;
  const anchor = buildAnchor(before, at, at + 'whole sentence'.length);
  assert.equal(anchor.quote, 'whole sentence');
  assert.equal(resolveAnchor(doc(p('blk_a', 'something else entirely')), anchor), null);
});

test('resolveAll skips page-level comments and reports orphans', () => {
  const document = doc(p('blk_a', 'findable text'));
  const anchor = buildAnchor(document, 1, 9);

  const resolved = resolveAll(document, [
    { id: 'page-level', anchor: null, content: 'about the page' },
    { id: 'anchored', anchor },
    { id: 'orphan', anchor: { blockId: 'blk_gone', quote: 'not here any more', offset: 0 } },
  ]);

  assert.deepEqual(resolved.map((r) => r.id), ['anchored', 'orphan']);
  assert.equal(textOf(document, resolved[0].range), 'findable');
  assert.equal(resolved[1].range, null);
});

test('quotePreview collapses whitespace and truncates', () => {
  assert.equal(quotePreview({ quote: '  a\n  b  ' }), 'a b');
  assert.equal(quotePreview({ quote: 'x'.repeat(20) }, 10).length, 10);
  assert.equal(quotePreview(null), '');
});

test('isValidAnchor accepts null and rejects malformed input', () => {
  assert.equal(isValidAnchor(null), true, 'a page-level comment has no anchor');
  assert.equal(isValidAnchor({ blockId: 'blk_a', quote: 'hi', offset: 3 }), true);
  assert.equal(isValidAnchor({ quote: '   ' }), false);
  assert.equal(isValidAnchor({ quote: 'x'.repeat(1000) }), false);
  assert.equal(isValidAnchor({ quote: 'hi', offset: -1 }), false);
  assert.equal(isValidAnchor({ quote: 'hi', blockId: 42 }), false);
  assert.equal(isValidAnchor('not an object'), false);
  assert.equal(isValidAnchor([]), false);
});
