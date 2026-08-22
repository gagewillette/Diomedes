import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { buildAnchor } from '../lib/commentAnchor.js';
import { buildCommentDecorations, COMMENT_ID_ATTR } from './CommentHighlight.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: { blockId: { default: null } } },
    text: { group: 'inline' },
  },
  marks: {},
});

const p = (blockId, text) => schema.nodes.paragraph.create({ blockId }, text ? schema.text(text) : null);
const doc = (...nodes) => schema.nodes.doc.create(null, nodes);

/** Every highlight, as the plain facts a test cares about. */
const marks = (document, comments, activeId) =>
  buildCommentDecorations(document, comments, activeId)
    .decorations.find()
    .map((d) => ({
      id: d.type.attrs[COMMENT_ID_ATTR],
      text: document.textBetween(d.from, d.to),
      class: d.type.attrs.class,
      approximate: d.type.attrs['data-comment-approximate'] === 'true',
    }));

test('a page-level comment draws nothing', () => {
  const document = doc(p('blk_a', 'nothing is highlighted here'));
  assert.deepEqual(marks(document, [{ id: 'c1', anchor: null }]), []);
});

test('an anchored comment highlights exactly its own words', () => {
  const document = doc(p('blk_a', 'the quick brown fox'));
  const anchor = buildAnchor(document, 11, 20);

  assert.deepEqual(marks(document, [{ id: 'c1', anchor }]), [
    { id: 'c1', text: 'brown fox', class: 'gd-comment-mark', approximate: false },
  ]);
});

test('the active comment gets its own class', () => {
  const document = doc(p('blk_a', 'alpha'), p('blk_b', 'beta'));
  const comments = [
    { id: 'c1', anchor: buildAnchor(document, 1, 6) },
    { id: 'c2', anchor: buildAnchor(document, 8, 12) },
  ];

  const drawn = marks(document, comments, 'c2');
  assert.equal(drawn.find((m) => m.id === 'c1').class, 'gd-comment-mark');
  assert.equal(drawn.find((m) => m.id === 'c2').class, 'gd-comment-mark gd-comment-mark--active');
});

test('a comment found outside its block is flagged as approximate', () => {
  const before = doc(p('blk_a', 'a sentence with a claim in it'));
  const at = 1 + 'a sentence with a '.length;
  const anchor = buildAnchor(before, at, at + 5);

  const after = doc(p('blk_x', 'a sentence with'), p('blk_y', 'a claim in it'));
  assert.deepEqual(marks(after, [{ id: 'c1', anchor }]), [
    { id: 'c1', text: 'claim', class: 'gd-comment-mark', approximate: true },
  ]);
});

test('a comment whose text is gone draws nothing and breaks nothing', () => {
  const document = doc(p('blk_a', 'the text was rewritten'));
  const comments = [
    { id: 'gone', anchor: { blockId: 'blk_a', quote: 'deleted phrase', offset: 0 } },
    { id: 'here', anchor: buildAnchor(document, 5, 9) },
  ];

  assert.deepEqual(marks(document, comments).map((m) => m.id), ['here']);
});

test('overlapping comments on the same words are all drawn', () => {
  const document = doc(p('blk_a', 'one two three four'));
  const comments = [
    { id: 'wide', anchor: buildAnchor(document, 1, 14) },
    { id: 'narrow', anchor: buildAnchor(document, 5, 8) },
  ];

  const drawn = marks(document, comments);
  assert.equal(drawn.length, 2);
  assert.deepEqual(drawn.map((m) => m.text).sort(), ['one two three', 'two']);
});
