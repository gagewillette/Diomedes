import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import {
  BLOCK_ID_ATTR,
  isBlockId,
  newBlockId,
  stampMissingIds,
  topLevelBlockIds,
} from './blockId.js';

// A minimal doc/paragraph/heading/list schema carrying the same attribute the
// real one does. Building it here rather than booting a TipTap editor keeps the
// test free of a DOM while still exercising the actual ProseMirror logic.
const idAttr = { [BLOCK_ID_ATTR]: { default: null } };
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: idAttr },
    heading: { group: 'block', content: 'inline*', attrs: idAttr },
    // Deliberately without the attribute: proves an unstamped container is
    // skipped without stopping the walk into its stamped children.
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph+', attrs: idAttr },
    text: { group: 'inline' },
  },
});

const p = (text, id) =>
  schema.nodes.paragraph.create({ [BLOCK_ID_ATTR]: id ?? null }, text ? schema.text(text) : null);

const stateOf = (...nodes) => EditorState.create({ doc: schema.nodes.doc.create(null, nodes) });

/** Run the stamper and return the resulting document as JSON. */
function stamp(state) {
  const tr = stampMissingIds(state);
  return (tr ? state.apply(tr) : state).doc.toJSON();
}

const idsOf = (doc) => doc.content.map((n) => n.attrs?.[BLOCK_ID_ATTR]);

test('a fresh id is well formed and recognised', () => {
  const id = newBlockId();
  assert.ok(isBlockId(id), id);
  assert.equal(id.length, 26); // 'blk_' + 10 time + 12 random
});

test('ids sort by creation time', () => {
  const early = newBlockId(1_700_000_000_000);
  const late = newBlockId(1_800_000_000_000);
  assert.ok(early < late, `${early} < ${late}`);
});

test('a thousand ids generated in the same millisecond are all distinct', () => {
  const now = Date.now();
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(newBlockId(now));
  assert.equal(ids.size, 1000);
});

test('blocks without an id are given one', () => {
  const doc = stamp(stateOf(p('one'), p('two')));
  const ids = idsOf(doc);
  assert.ok(ids.every(isBlockId), JSON.stringify(ids));
  assert.notEqual(ids[0], ids[1]);
});

test('blocks that already have an id are left alone', () => {
  const a = newBlockId();
  const b = newBlockId();
  const doc = stamp(stateOf(p('one', a), p('two', b)));
  assert.deepEqual(idsOf(doc), [a, b]);
});

test('a document that needs nothing produces no transaction', () => {
  const state = stateOf(p('one', newBlockId()), p('two', newBlockId()));
  assert.equal(stampMissingIds(state), null);
});

// This is the copy/paste story: ProseMirror serialises a copy with its
// attributes intact, so pasting into the same page arrives holding an id that
// is already taken. The second occurrence has to be renamed.
test('a duplicated id is broken by renaming the later block', () => {
  const shared = newBlockId();
  const doc = stamp(stateOf(p('original', shared), p('pasted copy', shared)));
  const ids = idsOf(doc);
  assert.equal(ids[0], shared, 'the first occurrence keeps the id');
  assert.ok(isBlockId(ids[1]));
  assert.notEqual(ids[1], shared);
});

// Cut/paste is a move, not a copy: nothing collides, so the block keeps its
// name and the embedding queue sees a move rather than a delete plus an insert.
test('a block that arrives with an unused id keeps it', () => {
  const carried = newBlockId();
  const doc = stamp(stateOf(p('local', newBlockId()), p('moved in', carried)));
  assert.equal(idsOf(doc)[1], carried);
});

test('a malformed id is replaced rather than trusted', () => {
  const doc = stamp(stateOf(p('one', 'not-an-id'), p('two', '')));
  assert.ok(idsOf(doc).every(isBlockId));
});

test('nested blocks inside an unstamped container are still stamped', () => {
  const item = schema.nodes.listItem.create(null, p('a point'));
  const list = schema.nodes.bulletList.create(null, item);
  const doc = stamp(stateOf(list, p('after')));
  const listItem = doc.content[0].content[0];
  assert.ok(isBlockId(listItem.attrs[BLOCK_ID_ATTR]), 'the list item got an id');
  assert.ok(isBlockId(listItem.content[0].attrs[BLOCK_ID_ATTR]), 'its paragraph got one too');
});

test('stamping is not added to the undo history', () => {
  const tr = stampMissingIds(stateOf(p('one')));
  assert.equal(tr.getMeta('addToHistory'), false);
});

test('topLevelBlockIds reads ids in document order and skips unstamped nodes', () => {
  const a = newBlockId();
  const b = newBlockId();
  const doc = { type: 'doc', content: [{ attrs: { blockId: a } }, {}, { attrs: { blockId: b } }] };
  assert.deepEqual(topLevelBlockIds(doc), [a, b]);
  assert.deepEqual(topLevelBlockIds(null), []);
  assert.deepEqual(topLevelBlockIds({ type: 'doc' }), []);
});
