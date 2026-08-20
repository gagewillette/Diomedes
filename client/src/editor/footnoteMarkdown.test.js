import './domForTests.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { Footnote, FootnoteRef, Footnotes } from './nodes/footnoteNodes.js';

// The node views are the only thing Footnote.jsx adds, and they have no say in
// how a document serialises — so the markdown round trip is tested against the
// base nodes, which `node --test` can load without a JSX transform.

// The same document shape the app builds, minus everything irrelevant to
// markdown. `block+ footnotes?` has to be here too — without it the parsed
// container has nowhere to go and every imported footnote is silently dropped,
// which is the exact failure this file exists to catch.
function editorWith(content = '') {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document.extend({ content: 'block+ footnotes?' }),
      StarterKit.configure({ document: false }),
      Link,
      FootnoteRef, Footnote, Footnotes,
      Markdown.configure({ html: false }),
    ],
    content,
  });
}

/** markdown → editor → markdown. */
function roundTrip(md) {
  const editor = editorWith(md);
  const out = editor.storage.markdown.getMarkdown();
  editor.destroy();
  return out;
}

function jsonFrom(md) {
  const editor = editorWith(md);
  const json = editor.getJSON();
  editor.destroy();
  return json;
}

const container = (json) => json.content?.find((n) => n.type === 'footnotes');
const refsIn = (json) => {
  const found = [];
  const walk = (node) => {
    if (node.type === 'footnoteRef') found.push(node);
    (node.content || []).forEach(walk);
  };
  walk(json);
  return found;
};

test('a reference and its definition become real nodes', () => {
  const json = jsonFrom('A claim.[^1]\n\n[^1]: The evidence.\n');
  const notes = container(json);

  assert.ok(notes, 'the document has a footnotes container');
  assert.equal(notes.content.length, 1);
  assert.equal(notes.content[0].type, 'footnote');

  const refs = refsIn(json);
  assert.equal(refs.length, 1);
  // The ref and its note are joined by a minted id, not by the label the
  // markdown happened to use.
  assert.equal(refs[0].attrs.footnoteId, notes.content[0].attrs.footnoteId);
  assert.match(refs[0].attrs.footnoteId, /^fn_/);
});

test('the container is the last child of the document', () => {
  const json = jsonFrom('One.[^1]\n\nTwo.\n\n[^1]: Note.\n');
  assert.equal(json.content[json.content.length - 1].type, 'footnotes');
});

test('a simple footnote round-trips unchanged', () => {
  const md = 'A claim.[^1]\n\n[^1]: The evidence.';
  assert.equal(roundTrip(md), md);
});

test('two footnotes round-trip in order', () => {
  const md = 'First.[^1] Second.[^2]\n\n[^1]: One.\n\n[^2]: Two.';
  assert.equal(roundTrip(md), md);
});

test('a named label is imported and exported as a number', () => {
  // Obsidian allows `[^order-keys]`; the number is presentation, so the export
  // normalises to it rather than preserving a label nobody sees.
  const out = roundTrip('See here.[^order-keys]\n\n[^order-keys]: Fractional indexing.');
  assert.equal(out, 'See here.[^1]\n\n[^1]: Fractional indexing.');
});

test('numbers follow document order, not the labels in the source', () => {
  const out = roundTrip('Alpha.[^9] Beta.[^2]\n\n[^9]: Nine.\n\n[^2]: Two.');
  assert.equal(out, 'Alpha.[^1] Beta.[^2]\n\n[^1]: Nine.\n\n[^2]: Two.');
});

test('an inline footnote becomes a real note at the bottom', () => {
  const json = jsonFrom('A claim.^[Written inline.]');
  const notes = container(json);
  assert.ok(notes);
  assert.equal(notes.content[0].content[0].content[0].text, 'Written inline.');
  assert.equal(refsIn(json).length, 1);
});

test('a multi-paragraph footnote keeps both paragraphs', () => {
  const json = jsonFrom('Claim.[^1]\n\n[^1]: First paragraph.\n\n    Second paragraph.\n');
  const note = container(json).content[0];
  assert.equal(note.content.length, 2);
  assert.equal(note.content[1].content[0].text, 'Second paragraph.');
});

test('a multi-paragraph footnote exports with four-space continuation', () => {
  // The indent is what makes Obsidian, Pandoc and GitHub all read the second
  // paragraph as part of the note rather than as body text.
  const out = roundTrip('Claim.[^1]\n\n[^1]: First paragraph.\n\n    Second paragraph.');
  assert.match(out, /^\[\^1\]: First paragraph\.\n\n {4}Second paragraph\.$/m);
  assert.equal(roundTrip(out), out, 're-importing the export is stable');
});

test('formatting inside a footnote survives the round trip', () => {
  const md = 'Claim.[^1]\n\n[^1]: See **the docs** and `order_key`.';
  assert.equal(roundTrip(md), md);
});

test('a link inside a footnote survives the round trip', () => {
  const md = 'Claim.[^1]\n\n[^1]: See [the design](https://example.com/design).';
  assert.equal(roundTrip(md), md);
});

test('a reference with no definition is left as literal text', () => {
  const json = jsonFrom('A claim.[^missing]\n');
  assert.equal(container(json), undefined);
  assert.equal(refsIn(json).length, 0);
  assert.equal(json.content[0].content[0].text, 'A claim.[^missing]');
});

test('a footnote cited twice exports two markers and one definition', () => {
  const md = 'One.[^1] Again.[^1]\n\n[^1]: Shared.';
  const json = jsonFrom(md);
  assert.equal(refsIn(json).length, 2, 'both citations survive import');
  assert.equal(container(json).content.length, 1, 'but there is only one note');
  assert.equal(roundTrip(md), md);
});

test('a document with no footnotes gains no apparatus', () => {
  const md = 'Just a paragraph.';
  assert.equal(roundTrip(md), md);
  assert.equal(container(jsonFrom(md)), undefined);
});

test('footnote syntax inside a code fence is left alone', () => {
  const md = '```\nsee [^1] here\n```';
  assert.equal(container(jsonFrom(md)), undefined);
  assert.equal(roundTrip(md), md);
});

test('a reference inside a list item is supported', () => {
  const md = '*   A point.[^1]\n\n[^1]: Supporting note.';
  const json = jsonFrom(md);
  assert.equal(refsIn(json).length, 1);
  assert.ok(container(json));
});
