import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import {
  FOOTNOTE_ID_ATTR,
  citationCounts,
  entryTextPos,
  findContainer,
  findEntries,
  findRefs,
  insertFootnote,
  isFootnoteId,
  newFootnoteId,
  numberFootnotes,
  syncFootnotes,
} from './footnotes.js';

// The same shape the real extensions build, minus everything that needs a DOM.
// `block+ footnotes?` is the constraint doing the real work: it is what makes
// the container a singleton pinned to the end of the document, so no code has
// to police either property.
const idAttr = { [FOOTNOTE_ID_ATTR]: { default: null } };
const schema = new Schema({
  nodes: {
    doc: { content: 'block+ footnotes?' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    footnoteRef: { group: 'inline', inline: true, atom: true, attrs: idAttr },
    footnote: { content: 'block+', attrs: idAttr, isolating: true },
    footnotes: { content: 'footnote+', isolating: true },
  },
});

const { paragraph, footnoteRef, footnote, footnotes } = schema.nodes;

/** A paragraph of `parts`, where a bare string is text and an id is a ref. */
const p = (...parts) =>
  paragraph.create(
    null,
    parts.map((part) =>
      typeof part === 'string' && !part.startsWith('fn_')
        ? schema.text(part)
        : footnoteRef.create({ [FOOTNOTE_ID_ATTR]: part })
    )
  );

const note = (id, body = 'note') => footnote.create({ [FOOTNOTE_ID_ATTR]: id }, p(body));

const docOf = (...nodes) => schema.nodes.doc.create(null, nodes);
const stateOf = (...nodes) => EditorState.create({ doc: docOf(...nodes) });

/** Run the reconciler to a fixed point and return the resulting document. */
function sync(state) {
  let current = state;
  for (let i = 0; i < 5; i++) {
    const tr = syncFootnotes(current);
    if (!tr) return current.doc;
    current = current.apply(tr);
  }
  throw new Error('syncFootnotes did not settle');
}

const A = 'fn_000000000000000000000A';
const B = 'fn_000000000000000000000B';
const C = 'fn_000000000000000000000C';

test('newFootnoteId produces recognisable, sortable ids', () => {
  const early = newFootnoteId(1_000_000);
  const late = newFootnoteId(2_000_000);
  assert.ok(isFootnoteId(early));
  assert.ok(isFootnoteId(late));
  assert.ok(early < late, 'ids sort by creation time');
  assert.notEqual(newFootnoteId(1), newFootnoteId(1), 'same millisecond still collides never');
});

test('ids that are not footnote ids are rejected', () => {
  for (const bad of ['', null, 'fn_', 'blk_000000000000000000000A', 'fn_lowercase00000000000', undefined]) {
    assert.equal(isFootnoteId(bad), false, `${bad} should not pass`);
  }
});

test('numbering follows the order refs appear in the prose', () => {
  const doc = docOf(p('one', B), p('two', A), footnotes.create(null, [note(B), note(A)]));
  assert.deepEqual([...numberFootnotes(doc)], [[B, 1], [A, 2]]);
});

test('a footnote cited twice keeps one number', () => {
  const doc = docOf(p('a', A), p('b', B), p('c', A), footnotes.create(null, [note(A), note(B)]));
  assert.deepEqual([...numberFootnotes(doc)], [[A, 1], [B, 2]]);
  assert.deepEqual([...citationCounts(doc)], [[A, 2], [B, 1]]);
});

test('an already-consistent document is left alone', () => {
  const state = stateOf(p('a', A), footnotes.create(null, [note(A)]));
  assert.equal(syncFootnotes(state), null);
});

test('a document with no footnotes at all is left alone', () => {
  assert.equal(syncFootnotes(stateOf(p('nothing here'))), null);
});

test('deleting a ref deletes its note', () => {
  // The prose no longer cites A; only B survives.
  const doc = sync(stateOf(p('a'), p('b', B), footnotes.create(null, [note(A), note(B)])));
  assert.deepEqual(findEntries(doc).map((e) => e.id), [B]);
});

test('deleting the last note removes the whole apparatus', () => {
  const doc = sync(stateOf(p('a'), footnotes.create(null, [note(A)])));
  assert.equal(findContainer(doc), null);
  assert.equal(doc.childCount, 1);
});

test('deleting a note deletes every ref that cited it', () => {
  const doc = sync(stateOf(p('a', A), p('b', A, B), footnotes.create(null, [note(B)])));
  assert.deepEqual(findRefs(doc).refs.map((r) => r.id), [B]);
  assert.equal(doc.textContent.includes('a'), true, 'surrounding text survives');
});

test('a ref pasted without its note is dropped, not left dangling', () => {
  const doc = sync(stateOf(p('orphan', C)));
  assert.deepEqual(findRefs(doc).refs, []);
  assert.equal(doc.textContent, 'orphan');
});

test('entries are reordered to match reference order', () => {
  const doc = sync(stateOf(p('a', C), p('b', A), p('c', B), footnotes.create(null, [note(A), note(B), note(C)])));
  assert.deepEqual(findEntries(doc).map((e) => e.id), [C, A, B]);
  assert.deepEqual([...numberFootnotes(doc)], [[C, 1], [A, 2], [B, 3]]);
});

test('reordering preserves each note body', () => {
  const doc = sync(
    stateOf(p('a', B), p('b', A), footnotes.create(null, [note(A, 'about A'), note(B, 'about B')]))
  );
  assert.deepEqual(findEntries(doc).map((e) => e.node.textContent), ['about B', 'about A']);
});

test('a ref nested inside a footnote is removed', () => {
  const nested = footnote.create({ [FOOTNOTE_ID_ATTR]: A }, p('see also ', B));
  const doc = sync(stateOf(p('a', A), footnotes.create(null, [nested])));
  assert.deepEqual(findRefs(doc).nested, []);
  assert.deepEqual(findEntries(doc).map((e) => e.id), [A]);
});

test('insertFootnote adds a ref and its note in one transaction', () => {
  const state = stateOf(p('claim'));
  const { tr, id } = insertFootnote(state.tr, schema, 6); // end of "claim"
  const doc = state.apply(tr).doc;

  assert.deepEqual(findRefs(doc).refs.map((r) => r.id), [id]);
  assert.deepEqual(findEntries(doc).map((e) => e.id), [id]);
  // The pair is consistent the moment it lands — the reconciler has no
  // orphan to find and nothing to undo.
  assert.equal(syncFootnotes(state.apply(tr)), null);
});

test('insertFootnote reuses the existing container', () => {
  const state = stateOf(p('a', A), footnotes.create(null, [note(A)]));
  const { tr } = insertFootnote(state.tr, schema, 2);
  const doc = state.apply(tr).doc;
  assert.equal(doc.content.content.filter((n) => n.type.name === 'footnotes').length, 1);
  assert.equal(findEntries(doc).length, 2);
});

test('the caret lands inside the new note', () => {
  const state = stateOf(p('claim'));
  const { tr, id } = insertFootnote(state.tr, schema, 6);
  const doc = state.apply(tr).doc;
  const pos = entryTextPos(doc, id);
  assert.ok(pos !== null);
  // Resolving there must put us in a textblock, or typing would throw.
  assert.equal(doc.resolve(pos).parent.type.name, 'paragraph');
});

// createChecked, not create: only the checked form validates the content
// expression, and these two assertions are the whole reason the container
// needs no runtime policing.
const checkedDoc = (...nodes) => schema.nodes.doc.createChecked(null, nodes);

test('the schema refuses a second container', () => {
  assert.throws(() => checkedDoc(p('a'), footnotes.create(null, [note(A)]), footnotes.create(null, [note(B)])));
});

test('the schema refuses body content after the container', () => {
  assert.throws(() => checkedDoc(p('a'), footnotes.create(null, [note(A)]), p('after')));
});

test('the schema accepts the container in last position', () => {
  assert.doesNotThrow(() => checkedDoc(p('a'), footnotes.create(null, [note(A)])));
});
