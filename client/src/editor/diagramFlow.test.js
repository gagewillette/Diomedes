import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { caretTargetAfterBlock } from './diagramFlow.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    mermaidDiagram: { group: 'block', atom: true, selectable: true },
    callout: { group: 'block', content: 'block+' },
    text: { group: 'inline' },
  },
});

const { doc, paragraph, mermaidDiagram, callout } = schema.nodes;
const p = (text) => paragraph.create(null, text ? schema.text(text) : null);
const d = () => mermaidDiagram.create();
const build = (...nodes) => doc.create(null, nodes);

test('a diagram at the end of the document wants a paragraph made', () => {
  const document = build(p('intro'), d());
  const diagramPos = p('intro').nodeSize;
  assert.deepEqual(caretTargetAfterBlock(document, diagramPos), {
    pos: document.content.size,
    insert: true,
  });
});

test('an empty paragraph already below the diagram is reused', () => {
  const document = build(d(), p());
  const target = caretTargetAfterBlock(document, 0);
  assert.equal(target.insert, false);
  // The reported position is the paragraph's own start, so pos + 1 is inside it.
  assert.equal(target.pos, d().nodeSize);
  assert.doesNotThrow(() => document.resolve(target.pos + 1));
});

test('a paragraph with text below the diagram is not typed into', () => {
  const document = build(d(), p('existing prose'));
  assert.equal(caretTargetAfterBlock(document, 0).insert, true);
});

test('a second diagram below the first is not mistaken for a line', () => {
  const document = build(d(), d());
  assert.equal(caretTargetAfterBlock(document, 0).insert, true);
});

test('a diagram nested in a callout resolves against its own parent', () => {
  const document = build(callout.create(null, [d(), p()]));
  // 1 is inside the callout, at the start of the diagram.
  const target = caretTargetAfterBlock(document, 1);
  assert.equal(target.insert, false);
  assert.equal(target.pos, 1 + d().nodeSize);
});

test('a diagram that is the last child of a callout still wants a paragraph', () => {
  const document = build(callout.create(null, [p('note'), d()]));
  const target = caretTargetAfterBlock(document, 1 + p('note').nodeSize);
  assert.equal(target.insert, true);
});

test('a stale position yields no target rather than a wrong one', () => {
  const document = build(p('only'));
  assert.equal(caretTargetAfterBlock(document, 9999), null);
  assert.equal(caretTargetAfterBlock(document, -1), null);
  assert.equal(caretTargetAfterBlock(document, undefined), null);
  // A position with nothing after it (the very end) has no block to step over.
  assert.equal(caretTargetAfterBlock(document, document.content.size), null);
});
