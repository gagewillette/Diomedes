import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { findWikiLinkMatch } from './wikiLinkMatch.js';

// Just enough schema to hold a paragraph with an inline atom in it — the atom
// stands in for a page link chip, which the matcher must refuse to reach past.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    chip: { group: 'inline', inline: true, atom: true },
  },
});

/** Match at the caret marked by `|` in `text`, which becomes one paragraph. */
const matchAt = (text) => {
  const caret = text.indexOf('|');
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text.replace('|', '') ? [schema.text(text.replace('|', ''))] : []),
  ]);
  const state = EditorState.create({ doc });
  // +1 for the paragraph's own opening token.
  return findWikiLinkMatch({ $position: state.doc.resolve(caret + 1) });
};

/** The document text with the matched range cut out, so ranges are readable. */
const cut = (text, match) => {
  const plain = text.replace('|', '');
  return `${plain.slice(0, match.range.from - 1)}⟦⟧${plain.slice(match.range.to - 1)}`;
};

test('a half-typed link matches up to the caret', () => {
  const m = matchAt('see [[Sea|');
  assert.equal(m.query, 'Sea');
  assert.equal(m.text, '[[Sea');
  assert.equal(cut('see [[Sea|', m), 'see ⟦⟧');
});

test('a caret inside a written-out link consumes the whole thing', () => {
  const src = 'see [[Se|arch]] now';
  const m = matchAt(src);
  assert.equal(m.query, 'Search');
  assert.equal(m.text, '[[Search]]');
  assert.equal(cut(src, m), 'see ⟦⟧ now');
});

test('a caret at the start of a written-out link still takes all of it', () => {
  const src = '[[|Search]]';
  const m = matchAt(src);
  assert.equal(m.query, 'Search');
  assert.equal(cut(src, m), '⟦⟧');
});

test('a caret just before the closing brackets takes them too', () => {
  const src = '[[Search|]] tail';
  const m = matchAt(src);
  assert.equal(m.query, 'Search');
  assert.equal(cut(src, m), '⟦⟧ tail');
});

test('only the first closing brackets are consumed', () => {
  const src = 'a [[Se|arch]] b [[Other]]';
  const m = matchAt(src);
  assert.equal(m.query, 'Search');
  assert.equal(cut(src, m), 'a ⟦⟧ b [[Other]]');
});

test('text after the caret that never closes is left alone', () => {
  const src = 'x [[Se|arch and more';
  const m = matchAt(src);
  assert.equal(m.query, 'Se');
  assert.equal(cut(src, m), 'x ⟦⟧arch and more');
});

test('a stray bracket after the caret stops the forward scan', () => {
  const src = '[[Se|arch [x]] end';
  const m = matchAt(src);
  assert.equal(m.query, 'Se');
  assert.equal(cut(src, m), '⟦⟧arch [x]] end');
});

test('a closed link before the caret does not match', () => {
  assert.equal(matchAt('[[Search]] and |'), null);
});

test('no opening brackets means no match', () => {
  assert.equal(matchAt('plain text|'), null);
});

test('an over-long title is not a link', () => {
  assert.equal(matchAt(`[[${'x'.repeat(130)}|`), null);
});

test('an over-long title is not a link even split around the caret', () => {
  assert.equal(matchAt(`[[${'x'.repeat(60)}|${'y'.repeat(70)}]]`), null);
});

test('an inline atom before the caret blocks the match', () => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('[[Se'), schema.node('chip'), schema.text('a')]),
  ]);
  const state = EditorState.create({ doc });
  assert.equal(findWikiLinkMatch({ $position: state.doc.resolve(doc.content.size - 1) }), null);
});

test('an inline atom after the caret stops the forward scan', () => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('[[Se'), schema.node('chip'), schema.text(']]')]),
  ]);
  const state = EditorState.create({ doc });
  // Caret sits right after `[[Se`, before the atom.
  const m = findWikiLinkMatch({ $position: state.doc.resolve(5) });
  assert.equal(m.query, 'Se');
  assert.equal(m.range.to, 5);
});
