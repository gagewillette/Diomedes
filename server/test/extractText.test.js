import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../src/lib/util.js';

// `pages.text_content` and the tsvector built from it are the whole of
// full-text search. A node type this walk does not reach is a node type nobody
// can search for — silently, with nothing in the UI to suggest the text was
// ever there. Footnotes are the easy one to get wrong: they are nested two
// levels deeper than body prose and were added long after this function.

const doc = (...content) => ({ type: 'doc', content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

const footnotes = (...notes) => ({
  type: 'footnotes',
  content: notes.map((text, i) => ({
    type: 'footnote',
    attrs: { footnoteId: `fn_${i}` },
    content: [para(text)],
  })),
});

test('footnote bodies reach the search index', () => {
  const text = extractText(doc(para('A claim.'), footnotes('Fractional indexing.', 'See PR 32.')));
  assert.match(text, /Fractional indexing\./);
  assert.match(text, /See PR 32\./);
});

test('footnote text is labelled so a search snippet does not read as body prose', () => {
  const text = extractText(doc(para('A claim.'), footnotes('The note.')));
  assert.match(text, /Footnotes:/);
  assert.ok(text.indexOf('A claim.') < text.indexOf('Footnotes:'), 'the label sits with the notes, not the body');
});

test('a multi-paragraph footnote contributes both paragraphs', () => {
  const note = { type: 'footnote', attrs: { footnoteId: 'fn_0' }, content: [para('First.'), para('Second.')] };
  const text = extractText(doc(para('Body.'), { type: 'footnotes', content: [note] }));
  assert.match(text, /First\./);
  assert.match(text, /Second\./);
});

test('a page with no footnotes gains no label', () => {
  assert.doesNotMatch(extractText(doc(para('Just prose.'))), /Footnotes:/);
});

test('the reference marker itself contributes no text', () => {
  // The number is a decoration, not content — there is nothing in the node to
  // index, and a stray "1" in the search text would be noise.
  const withRef = doc({
    type: 'paragraph',
    content: [{ type: 'text', text: 'A claim.' }, { type: 'footnoteRef', attrs: { footnoteId: 'fn_0' } }],
  });
  assert.equal(extractText(withRef).trim(), 'A claim.');
});
