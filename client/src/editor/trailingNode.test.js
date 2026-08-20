import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { trailingParagraphPos } from './trailingNode.js';

// The shape that matters: `block+ footnotes?`, an atom diagram block, and a
// table — the three ingredients of the "nowhere to put the caret" bug. Built
// here rather than by booting TipTap so the test needs no DOM.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+ footnotes?' },
    paragraph: { group: 'block', content: 'inline*' },
    mermaidDiagram: { group: 'block', atom: true, selectable: true },
    table: { group: 'block', content: 'paragraph+' },
    footnotes: { content: 'paragraph*' },
    text: { group: 'inline' },
  },
});

const { doc, paragraph, mermaidDiagram, table, footnotes } = schema.nodes;
const p = (text) => paragraph.create(null, text ? schema.text(text) : null);
const d = () => mermaidDiagram.create();
const build = (...nodes) => doc.create(null, nodes);

test('a document ending in a paragraph needs nothing', () => {
  assert.equal(trailingParagraphPos(build(p('one'), p('two'))), null);
});

test('a document ending in an empty paragraph needs nothing', () => {
  assert.equal(trailingParagraphPos(build(d(), p())), null);
});

test('a diagram at the end earns a paragraph after it', () => {
  const document = build(p('intro'), d());
  assert.equal(trailingParagraphPos(document), document.content.size);
});

test('a table at the end earns one too', () => {
  const document = build(table.create(null, p('cell')));
  assert.equal(trailingParagraphPos(document), document.content.size);
});

test('a diagram in the middle is left alone', () => {
  assert.equal(trailingParagraphPos(build(d(), p('after'))), null);
});

test('the paragraph goes before the footnote apparatus, not after it', () => {
  const notes = footnotes.create(null, p('a note'));
  const document = build(p('intro'), d(), notes);
  const pos = trailingParagraphPos(document);
  assert.equal(pos, document.content.size - notes.nodeSize);
  // And the result is a document the schema still accepts.
  const next = document.copy(document.content.replaceChild(2, paragraph.create()).addToEnd(notes));
  assert.doesNotThrow(() => next.check());
});

test('footnotes after a paragraph need no help', () => {
  const document = build(p('body'), footnotes.create(null, p('a note')));
  assert.equal(trailingParagraphPos(document), null);
});

test('a document that is only footnotes still gets a line to type on', () => {
  const notes = footnotes.create(null, p('a note'));
  // `block+` forbids this shape, so build the node list directly — the guard
  // exists for documents arriving from outside the editor.
  const document = doc.create(null, [notes]);
  assert.equal(trailingParagraphPos(document), 0);
});

test('an empty document is left to the schema', () => {
  assert.equal(trailingParagraphPos(doc.create()), null);
});
