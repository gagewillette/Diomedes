import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { buildAnchor } from '../lib/commentAnchor.js';
import { pickUserColor, withAlpha } from '../lib/userColor.js';
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
      style: d.type.attrs.style || '',
      approximate: d.type.attrs['data-comment-approximate'] === 'true',
    }));

test('a page-level comment draws nothing', () => {
  const document = doc(p('blk_a', 'nothing is highlighted here'));
  assert.deepEqual(marks(document, [{ id: 'c1', anchor: null }]), []);
});

test('an anchored comment highlights exactly its own words', () => {
  const document = doc(p('blk_a', 'the quick brown fox'));
  const anchor = buildAnchor(document, 11, 20);

  const drawn = marks(document, [{ id: 'c1', anchor }]);
  assert.equal(drawn.length, 1);
  assert.deepEqual(
    { id: drawn[0].id, text: drawn[0].text, class: drawn[0].class, approximate: drawn[0].approximate },
    { id: 'c1', text: 'brown fox', class: 'gd-comment-mark', approximate: false },
  );
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
  const drawn = marks(after, [{ id: 'c1', anchor }]);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].text, 'claim');
  assert.equal(drawn[0].approximate, true);
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

test('a highlight is drawn in its author\'s presence colour', () => {
  const document = doc(p('blk_a', 'one two three four'));
  const alice = '11111111-1111-4111-8111-111111111111';
  const bob = '22222222-2222-4222-8222-222222222222';

  const drawn = marks(document, [
    { id: 'c1', user_id: alice, anchor: buildAnchor(document, 1, 4) },
    { id: 'c2', user_id: bob, anchor: buildAnchor(document, 9, 14) },
  ]);

  // The same function the collaboration caret uses, so a comment's highlight
  // and its author's cursor are the same colour.
  assert.ok(drawn[0].style.includes(withAlpha(pickUserColor(alice), 0.18)));
  assert.ok(drawn[1].style.includes(withAlpha(pickUserColor(bob), 0.18)));
  assert.ok(drawn[0].style.includes(`--gd-comment-color: ${pickUserColor(alice)}`));
});

test('two people commenting get visibly different colours', () => {
  // Not a property of any one pair of ids, so the test states the thing that
  // actually matters: the palette separates people rather than collapsing them.
  const ids = Array.from({ length: 8 }, (_, i) => `user-${i}`);
  const colors = new Set(ids.map(pickUserColor));
  assert.ok(colors.size > 1, 'distinct users must not all share one colour');
});

test('the active highlight keeps the author colour, at more weight', () => {
  const document = doc(p('blk_a', 'some commented words'));
  const alice = '11111111-1111-4111-8111-111111111111';
  const comments = [{ id: 'c1', user_id: alice, anchor: buildAnchor(document, 1, 5) }];

  const resting = marks(document, comments)[0];
  const active = marks(document, comments, 'c1')[0];

  assert.ok(resting.style.includes(withAlpha(pickUserColor(alice), 0.18)));
  assert.ok(active.style.includes(withAlpha(pickUserColor(alice), 0.42)));
  assert.ok(active.style.includes('box-shadow'), 'the active one is also ringed');
  assert.equal(active.class, 'gd-comment-mark gd-comment-mark--active');
});

test('a resolved comment is not highlighted in the document', () => {
  const document = doc(p('blk_a', 'open point'), p('blk_b', 'settled point'));
  const drawn = marks(document, [
    { id: 'open', anchor: buildAnchor(document, 1, 5), resolved: false },
    { id: 'settled', anchor: buildAnchor(document, 13, 20), resolved: true },
  ]);

  assert.deepEqual(drawn.map((m) => m.id), ['open'], 'a finished conversation leaves the page clean');
});

test('a resolved comment still reports as resolvable, not as lost text', () => {
  // The distinction the panel depends on: "settled" and "the text this was
  // about is gone" must not look the same to it.
  const document = doc(p('blk_a', 'settled point'));
  const { resolved } = buildCommentDecorations(
    document,
    [{ id: 'settled', anchor: buildAnchor(document, 1, 8), resolved: true }],
    null,
  );

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolved, true);
  assert.ok(resolved[0].range, 'its text is still findable — it is simply not drawn');
});
