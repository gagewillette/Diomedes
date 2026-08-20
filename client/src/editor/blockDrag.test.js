import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { BLOCK_ID_ATTR } from './blockId.js';
import { moveBlockBy } from './blockDrag.js';

// The same minimal schema blockId.test.js uses: enough of a document to move
// blocks around in, without a DOM or a TipTap editor.
const idAttr = { [BLOCK_ID_ATTR]: { default: null } };
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: idAttr },
    horizontalRule: { group: 'block', atom: true, selectable: true, attrs: idAttr },
    text: { group: 'inline' },
  },
});

const p = (text, id) =>
  schema.nodes.paragraph.create({ [BLOCK_ID_ATTR]: id ?? text }, text ? schema.text(text) : null);

const stateOf = (...nodes) => EditorState.create({ doc: schema.nodes.doc.create(null, nodes) });

/** Put the cursor inside the block at `index`, one character in. */
function withCursorIn(state, index) {
  let pos = 1;
  for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** Apply the move and return the resulting state, or null if it refused. */
function move(state, direction) {
  let next = null;
  const ok = moveBlockBy(state, (tr) => { next = state.apply(tr); }, direction);
  return ok ? next : null;
}

const idsOf = (state) => state.doc.content.content.map((n) => n.attrs[BLOCK_ID_ATTR]);

test('a block moves down past its neighbour', () => {
  const state = withCursorIn(stateOf(p('one'), p('two'), p('three')), 0);
  assert.deepEqual(idsOf(move(state, 1)), ['two', 'one', 'three']);
});

test('a block moves up past its neighbour', () => {
  const state = withCursorIn(stateOf(p('one'), p('two'), p('three')), 2);
  assert.deepEqual(idsOf(move(state, -1)), ['one', 'three', 'two']);
});

test('the moved block keeps its id — a move, not a delete and an insert', () => {
  const before = stateOf(p('one'), p('two'));
  const after = move(withCursorIn(before, 1), -1);
  assert.deepEqual(idsOf(after).sort(), idsOf(before).sort());
});

test('the cursor travels with the block', () => {
  const state = withCursorIn(stateOf(p('one'), p('two'), p('three')), 1);
  const after = move(state, 1);
  // Still one character into 'two', which is now the last block.
  assert.equal(after.selection.$from.parent.attrs[BLOCK_ID_ATTR], 'two');
  assert.equal(after.selection.from - after.selection.$from.before(1), 1);
});

test('the first block will not move up and the last will not move down', () => {
  const doc = stateOf(p('one'), p('two'));
  assert.equal(moveBlockBy(withCursorIn(doc, 0), null, -1), false);
  assert.equal(moveBlockBy(withCursorIn(doc, 1), null, 1), false);
});

test('a selection spanning two blocks refuses to move either', () => {
  const base = stateOf(p('one'), p('two'), p('three'));
  const across = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 2, 8)));
  assert.equal(moveBlockBy(across, null, 1), false);
});

test('a selected atom block moves and stays selected', () => {
  const base = stateOf(p('one'), schema.nodes.horizontalRule.create({ [BLOCK_ID_ATTR]: 'rule' }), p('two'));
  const selected = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, base.doc.child(0).nodeSize)));
  const after = move(selected, -1);

  assert.deepEqual(idsOf(after), ['rule', 'one', 'two']);
  assert.ok(after.selection instanceof NodeSelection);
  assert.equal(after.selection.node.attrs[BLOCK_ID_ATTR], 'rule');
});

test('moving down then up leaves the document as it was', () => {
  const before = stateOf(p('one'), p('two'), p('three'));
  const there = move(withCursorIn(before, 0), 1);
  const back = move(there, -1);
  assert.deepEqual(idsOf(back), idsOf(before));
});
