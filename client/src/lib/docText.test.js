import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'prosemirror-model';
import { buildTextIndex, findRanges } from './findText.js';

// A minimal doc/paragraph/text schema is enough to exercise position mapping.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: { inline: true },
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
});

const doc = (...paragraphs) =>
  schema.node('doc', null, paragraphs.map((p) =>
    schema.node('paragraph', null, p ? [schema.text(p)] : []),
  ));

/** Read the text a range covers, to prove positions point where we claim. */
const slice = (d, r) => d.textBetween(r.from, r.to);

test('text index separates blocks with a newline', () => {
  const { text } = buildTextIndex(doc('alpha', 'beta'));
  assert.equal(text, 'alpha\nbeta');
});

test('ranges point at the matched text in a single paragraph', () => {
  const d = doc('the quick brown fox');
  const { ranges } = findRanges(d, 'brown');
  assert.equal(ranges.length, 1);
  assert.equal(slice(d, ranges[0]), 'brown');
});

test('ranges stay correct across several paragraphs', () => {
  const d = doc('first needle here', 'second line', 'needle again');
  const { ranges } = findRanges(d, 'needle');
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges.map((r) => slice(d, r)), ['needle', 'needle']);
});

test('a match cannot span a paragraph boundary', () => {
  // "alpha" ends one paragraph and "beta" starts the next; the newline blocks it.
  const d = doc('alpha', 'beta');
  assert.equal(findRanges(d, 'alphabeta').ranges.length, 0);
  assert.equal(findRanges(d, 'alpha.beta', { regex: true }).ranges.length, 0);
});

test('regex anchors match per block, not just the document start', () => {
  const d = doc('alpha', 'beta');
  const { ranges } = findRanges(d, '^beta$', { regex: true });
  assert.equal(ranges.length, 1);
  assert.equal(slice(d, ranges[0]), 'beta');
  assert.equal(slice(d, findRanges(d, '^alpha', { regex: true }).ranges[0]), 'alpha');
});

test('ranges survive text split across marks', () => {
  const d = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('nee'),
      schema.text('dle', [schema.mark('strong')]),
    ]),
  ]);
  const { ranges } = findRanges(d, 'needle');
  assert.equal(ranges.length, 1);
  assert.equal(slice(d, ranges[0]), 'needle');
});

test('empty paragraphs do not shift positions', () => {
  const d = doc('alpha', '', 'target');
  const { ranges } = findRanges(d, 'target');
  assert.equal(slice(d, ranges[0]), 'target');
});
