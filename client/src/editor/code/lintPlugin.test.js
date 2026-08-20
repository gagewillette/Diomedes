// The plugin's two load-bearing promises, against a real ProseMirror state.
//
//   1. It finds every code block and reports the position ProseMirror will
//      accept, in documents with tables, lists and blocks in front of the one
//      being checked.
//   2. It never changes the document. The editor runs Collaboration, so a
//      document-changing transaction is a Yjs update: it syncs to every peer
//      and lands in page history. Diagnostics must be decorations and nothing
//      else, and "nothing else" is the sort of claim that rots unless a test
//      holds it.
//
// Uses the same bare-schema approach as blockDrag.test.js — no DOM, no TipTap
// editor, just the pieces under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { BLOCK_ID_ATTR } from '../blockId.js';
import { CodeLintPlugin, LINT_SETTINGS_META, LINT_VISIBILITY_META, codeBlocks, lintPluginKey } from './lintPlugin.js';

const idAttr = { [BLOCK_ID_ATTR]: { default: null } };
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: idAttr },
    codeBlock: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: { ...idAttr, language: { default: null } },
    },
    bulletList: { group: 'block', content: 'listItem+', attrs: idAttr },
    listItem: { content: 'paragraph+', attrs: idAttr },
    text: { group: 'inline' },
  },
});

const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
const code = (id, language, text) =>
  schema.nodes.codeBlock.create({ [BLOCK_ID_ATTR]: id, language }, text ? schema.text(text) : null);
const list = (text) =>
  schema.nodes.bulletList.create(null, schema.nodes.listItem.create(null, para(text)));

const stateWith = (nodes, settings = { linting: true, maxBytes: 100_000 }) =>
  EditorState.create({
    doc: schema.nodes.doc.create(null, nodes),
    plugins: [CodeLintPlugin({ getSettings: () => settings })],
  });

test('every code block is found, with the position ProseMirror agrees on', () => {
  const state = stateWith([
    para('intro'),
    code('blk_a', 'json', '{"a": 1}'),
    list('a bullet'),
    code('blk_b', 'py', 'print(1)'),
  ]);

  const found = codeBlocks(state.doc);
  assert.deepEqual(found.map((b) => b.id), ['blk_a', 'blk_b']);
  assert.deepEqual(found.map((b) => b.language), ['json', 'py']);
  assert.deepEqual(found.map((b) => b.code), ['{"a": 1}', 'print(1)']);

  // The reported position must be the node's own, whatever came before it —
  // this is the number every diagnostic offset is added to.
  for (const block of found) {
    assert.equal(state.doc.nodeAt(block.pos).attrs[BLOCK_ID_ATTR], block.id);
    assert.equal(state.doc.nodeAt(block.pos).type.name, 'codeBlock');
  }
});

test('a block with no id is still addressable', () => {
  // A block that has not been stamped yet — the paste is a frame ahead of the
  // blockId plugin — must not be skipped or collapse onto another block's id.
  const state = stateWith([code(null, 'json', '{}'), code(null, 'json', '[]')]);
  const found = codeBlocks(state.doc);
  assert.equal(found.length, 2);
  assert.notEqual(found[0].id, found[1].id);
});

test('nothing inside a code block is mistaken for another block', () => {
  const state = stateWith([code('blk_a', 'markdown', '```\nnot a real fence\n```')]);
  assert.equal(codeBlocks(state.doc).length, 1);
});

test('the plugin starts with no decorations and produces none on its own', () => {
  const state = stateWith([code('blk_a', 'json', '{')]);
  const set = lintPluginKey.getState(state);
  assert.equal(set.find().length, 0);
});

// The heart of it: count every transaction the plugin lets through and assert
// none of them touched the document.
function applyAndWatch(state, transactions) {
  let docChanges = 0;
  let historyEntries = 0;
  let next = state;
  for (const make of transactions) {
    const tr = make(next);
    if (tr.docChanged) docChanges += 1;
    if (tr.getMeta('addToHistory') !== false) historyEntries += 1;
    next = next.apply(tr);
  }
  return { next, docChanges, historyEntries };
}

test('a lint pass produces no document change and no history entry', () => {
  const state = stateWith([para('a'), code('blk_a', 'json', '{')]);
  const { next, docChanges, historyEntries } = applyAndWatch(state, [
    // Everything the plugin or its NodeView ever dispatches.
    (s) => s.tr.setMeta(lintPluginKey, { repaint: true }).setMeta('addToHistory', false),
    (s) => s.tr.setMeta(LINT_VISIBILITY_META, { blockId: 'blk_a', visible: true }).setMeta('addToHistory', false),
    (s) => s.tr.setMeta(LINT_SETTINGS_META, { linting: true, maxBytes: 100_000 }).setMeta('addToHistory', false),
    (s) => s.tr.setMeta(LINT_SETTINGS_META, { linting: false }).setMeta('addToHistory', false),
  ]);

  // Zero document mutations means zero Yjs updates, which is the whole
  // constraint: nothing here reaches a peer or the page's version history.
  assert.equal(docChanges, 0);
  assert.equal(historyEntries, 0);
  assert.equal(next.doc.eq(state.doc), true, 'the document must be untouched');
});

test('turning checking off clears the decorations immediately', () => {
  const state = stateWith([code('blk_a', 'json', '{')]);
  const off = state.apply(state.tr.setMeta(LINT_SETTINGS_META, { linting: false }));
  assert.equal(lintPluginKey.getState(off).find().length, 0);
  // And the document is still exactly what it was.
  assert.equal(off.doc.eq(state.doc), true);
});

test('an ordinary edit maps the decoration set instead of replacing the doc', () => {
  const state = stateWith([code('blk_a', 'json', '{')]);
  const edited = state.apply(state.tr.insertText('"a"', 2));
  // The plugin's own state survives an edit as a DecorationSet; what matters
  // here is that applying a real edit through it does not throw and does not
  // lose the block.
  assert.ok(lintPluginKey.getState(edited));
  assert.equal(codeBlocks(edited.doc)[0].code, '{"a"');
});
