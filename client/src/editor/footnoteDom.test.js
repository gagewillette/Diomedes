import './domForTests.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Footnote, FootnoteRef, Footnotes } from './nodes/footnoteNodes.js';
import { findEntries, findRefs, numberFootnotes } from './footnotes.js';

// The numbering is a decoration rendered by CSS `content: attr(data-n)`, which
// means the number only exists if the attribute actually lands on the element.
// Nothing in the pure tests can catch that — they never build a view — so this
// file boots a real editor and reads the DOM the browser would.
//
// The reference has no node view at all, so what is exercised here is exactly
// the production path for it. The two React node views are the only part not
// covered, and they render chrome, not the number.

function editorWith(content = '') {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document.extend({ content: 'block+ footnotes?' }),
      StarterKit.configure({ document: false }),
      FootnoteRef, Footnote, Footnotes,
      Markdown.configure({ html: false }),
    ],
    content,
  });
}

const refEls = (editor) => [...editor.view.dom.querySelectorAll('sup.gd-footnote-ref')];
const numbersInDom = (editor) => refEls(editor).map((el) => el.getAttribute('data-n'));

test('every reference is given its number as a DOM attribute', () => {
  const editor = editorWith('One.[^1] Two.[^2]\n\n[^1]: First.\n\n[^2]: Second.');
  assert.deepEqual(numbersInDom(editor), ['1', '2']);
  editor.destroy();
});

test('the number is announced to a screen reader, not left as bare punctuation', () => {
  const editor = editorWith('A claim.[^1]\n\n[^1]: The note.');
  const [ref] = refEls(editor);
  assert.equal(ref.getAttribute('aria-label'), 'Footnote 1');
  assert.equal(ref.getAttribute('role'), 'doc-noteref');
  assert.equal(ref.getAttribute('tabindex'), '0');
  editor.destroy();
});

test('the note carries the id the back-link and the jump both look for', () => {
  const editor = editorWith('A claim.[^1]\n\n[^1]: The note.');
  const id = findEntries(editor.state.doc)[0].id;
  // Set by the node view in the app; here the base node's renderHTML carries
  // the same id, which is what jumpToEntry resolves against.
  assert.equal(refEls(editor)[0].getAttribute('data-footnote-id'), id);
  editor.destroy();
});

test('addFootnote inserts a reference and drops the caret in the new note', () => {
  const editor = editorWith('A claim.');
  editor.commands.setTextSelection(9); // end of "A claim."
  editor.commands.addFootnote();

  const doc = editor.state.doc;
  assert.equal(findRefs(doc).refs.length, 1);
  assert.equal(findEntries(doc).length, 1);
  assert.deepEqual(numbersInDom(editor), ['1']);

  // The caret is inside the note, ready to type into — the whole point of the
  // slash command.
  const $from = editor.state.selection.$from;
  assert.equal($from.parent.type.name, 'paragraph');
  assert.equal($from.node(-1).type.name, 'footnote');
  editor.destroy();
});

test('typing into the new note lands in the note, not the prose', () => {
  const editor = editorWith('A claim.');
  editor.commands.setTextSelection(9);
  editor.commands.addFootnote();
  editor.commands.insertContent('The evidence.');

  assert.equal(findEntries(editor.state.doc)[0].node.textContent, 'The evidence.');
  assert.equal(editor.state.doc.child(0).textContent, 'A claim.', 'the prose is untouched');
  editor.destroy();
});

test('a second footnote inserted above the first renumbers both, live', () => {
  const editor = editorWith('First.[^1] Later.\n\n[^1]: Original note.');
  assert.deepEqual(numbersInDom(editor), ['1']);

  // Cite a new note at the very start of the paragraph, ahead of the existing
  // reference. Nothing is written to the old one — its number simply changes.
  editor.commands.setTextSelection(1);
  editor.commands.addFootnote();

  assert.deepEqual(numbersInDom(editor), ['1', '2']);
  const [first, second] = findRefs(editor.state.doc).refs;
  const numbers = numberFootnotes(editor.state.doc);
  assert.equal(numbers.get(first.id), 1);
  assert.equal(numbers.get(second.id), 2);
  editor.destroy();
});

test('the entries reorder to match, so the list still reads 1, 2', () => {
  const editor = editorWith('First.[^1] Later.\n\n[^1]: Original note.');
  const original = findEntries(editor.state.doc)[0].id;
  editor.commands.setTextSelection(1);
  editor.commands.addFootnote();

  const entries = findEntries(editor.state.doc);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].id, original, 'the original note moved to second place');
  editor.destroy();
});

test('deleting the sentence deletes its note and the apparatus with it', () => {
  const editor = editorWith('A claim.[^1]\n\n[^1]: The note.');
  assert.equal(findEntries(editor.state.doc).length, 1);

  // Select the whole first paragraph, reference included, and delete it.
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.child(0).nodeSize - 1 });
  editor.commands.deleteSelection();

  assert.deepEqual(findEntries(editor.state.doc), [], 'the note went with it');
  assert.equal(refEls(editor).length, 0);
  assert.equal(editor.view.dom.querySelector('[data-type="footnotes"]'), null);
  editor.destroy();
});

test('one note of two is removed without disturbing the other', () => {
  const editor = editorWith('One.[^1]\n\nTwo.[^2]\n\n[^1]: First.\n\n[^2]: Second.');
  const survivor = findEntries(editor.state.doc)[1].id;

  const firstPara = editor.state.doc.child(0);
  editor.commands.setTextSelection({ from: 1, to: firstPara.nodeSize - 1 });
  editor.commands.deleteSelection();

  const entries = findEntries(editor.state.doc);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, survivor);
  assert.deepEqual(numbersInDom(editor), ['1'], 'the survivor is renumbered to 1');
  editor.destroy();
});

test('citing an existing note adds a marker, not a second note', () => {
  const editor = editorWith('A claim.[^1] And again.\n\n[^1]: Shared.');
  const id = findEntries(editor.state.doc)[0].id;

  editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize - 1);
  editor.commands.citeFootnote(id);

  assert.equal(findRefs(editor.state.doc).refs.length, 2);
  assert.equal(findEntries(editor.state.doc).length, 1);
  // Both markers show the same number: the number names the note.
  assert.deepEqual(numbersInDom(editor), ['1', '1']);
  editor.destroy();
});

test('the inline ^[…] rule builds a note with the text already in it', () => {
  const editor = editorWith('A claim.');
  // Everything up to the closing bracket is just text; the rule fires on the
  // final `]`, so that one character has to arrive the way a keystroke does.
  editor.commands.insertContentAt(9, '^[Written inline');
  const at = editor.state.doc.child(0).nodeSize - 1;
  editor.commands.setTextSelection(at);
  editor.view.someProp('handleTextInput', (f) => f(editor.view, at, at, ']'));

  const entries = findEntries(editor.state.doc);
  assert.equal(entries.length, 1, 'the rule fired and made a note');
  assert.equal(entries[0].node.textContent, 'Written inline');
  assert.equal(findRefs(editor.state.doc).refs.length, 1);
  // The typed source is consumed, not left sitting in the prose.
  assert.equal(editor.state.doc.child(0).textContent, 'A claim.');
  editor.destroy();
});
