import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkPage, docBlocks, estimateTokens, MAX_CHUNK_TOKENS } from '../src/search/chunk.js';

const doc = (...content) => ({ type: 'doc', content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });

test('docBlocks skips empty nodes and tags heading levels', () => {
  const blocks = docBlocks(doc(heading(2, 'Setup'), para(''), para('Install it.')));
  // blockId is null here because these fixtures predate block ids; a document
  // written by the editor carries one per node. See blockEmbedding.test.js.
  assert.deepEqual(blocks, [
    { text: 'Setup', level: 2, blockId: null },
    { text: 'Install it.', level: 0, blockId: null },
  ]);
});

test('each chunk carries the page title and heading trail', () => {
  const chunks = chunkPage({
    title: 'Ops',
    content: doc(heading(1, 'Deploy'), para('Run the release script.'), heading(2, 'Rollback'), para('Pin the old tag.')),
  });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].content, /^Ops > Deploy\n\nRun the release script\.$/);
  assert.match(chunks[1].content, /^Ops > Deploy > Rollback\n\nPin the old tag\.$/);
});

test('a sibling heading replaces the deeper trail instead of nesting under it', () => {
  const chunks = chunkPage({
    title: 'Ops',
    content: doc(heading(1, 'Deploy'), heading(2, 'Rollback'), para('a'), heading(1, 'Monitoring'), para('b')),
  });
  assert.match(chunks[1].content, /^Ops > Monitoring\n\n/);
});

test('headings break chunks so sections never bleed together', () => {
  const chunks = chunkPage({ title: '', content: doc(para('one'), heading(1, 'Two'), para('three')) });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].content, 'one');
});

test('long sections split at the token cap with overlap for continuity', () => {
  const sentence = 'The deployment pipeline pushes the image to the registry. ';
  const chunks = chunkPage({ title: 'Long', content: doc(para(sentence.repeat(120))) });
  assert.ok(chunks.length > 1, 'expected the section to be split');
  for (const chunk of chunks) {
    assert.ok(chunk.tokenCount <= MAX_CHUNK_TOKENS * 1.2, `chunk ${chunk.index} is ${chunk.tokenCount} tokens`);
  }
  const tail = chunks[0].content.trim().split(/\s+/).slice(-5).join(' ');
  assert.ok(chunks[1].content.includes(tail), 'expected overlap from the previous chunk');
});

test('a single unbroken block longer than the cap is still split', () => {
  const chunks = chunkPage({ title: '', content: doc(para('word '.repeat(3000))) });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.tokenCount <= MAX_CHUNK_TOKENS * 1.2);
});

test('chunk indexes are contiguous from zero', () => {
  const chunks = chunkPage({ title: 'T', content: doc(para('a'), heading(1, 'B'), para('c'), heading(1, 'D'), para('e')) });
  assert.deepEqual(chunks.map((c) => c.index), [...chunks.keys()]);
});

test('a title-only page still yields one chunk', () => {
  const chunks = chunkPage({ title: 'Just a title', content: doc(para('')) });
  assert.deepEqual(chunks.map((c) => c.content), ['Just a title']);
});

test('a heading-only page keeps the heading text searchable', () => {
  const chunks = chunkPage({ title: '', content: doc(heading(1, 'Orphan section')) });
  assert.deepEqual(chunks.map((c) => c.content), ['Orphan section']);
});

test('an empty page produces no chunks', () => {
  assert.deepEqual(chunkPage({ title: '  ', content: doc(para('')) }), []);
  assert.deepEqual(chunkPage({}), []);
});

test('estimateTokens ignores surrounding whitespace', () => {
  assert.equal(estimateTokens('   abcd   '), 1);
  assert.equal(estimateTokens(''), 0);
});

/* ---------- footnotes ---------- */

const footnotes = (blockId, ...notes) => ({
  type: 'footnotes',
  attrs: { blockId },
  content: notes.map((text) => ({
    type: 'footnote',
    attrs: { footnoteId: `fn_${text}` },
    content: [para(text)],
  })),
});

test('each footnote becomes its own block, under a Footnotes heading', () => {
  const blocks = docBlocks(doc(para('A claim.'), footnotes('blk_fn', 'First note.', 'Second note.')));
  assert.deepEqual(blocks, [
    { text: 'A claim.', level: 0, blockId: null },
    { text: 'Footnotes', level: 1, blockId: 'blk_fn' },
    { text: 'First note.', level: 0, blockId: 'blk_fn' },
    { text: 'Second note.', level: 0, blockId: 'blk_fn' },
  ]);
});

test('a footnote chunk is prefixed Footnotes, not the last section on the page', () => {
  const chunks = chunkPage({
    title: 'Ops',
    content: doc(heading(2, 'Rollback'), para('Pin the old tag.'), footnotes('blk_fn', 'Tags are immutable.')),
  });
  const note = chunks.find((c) => c.content.includes('Tags are immutable.'));
  assert.ok(note, 'the footnote text is embedded somewhere');
  assert.match(note.content, /^Ops > Footnotes\n\n/);
});

test('footnote chunks are attributed to the container, which is what a save reports', () => {
  // splitBlocks projects top-level nodes, so an edit to any note reports the
  // container id. A chunk claiming the note's own id would never re-embed.
  const chunks = chunkPage({ title: 'Ops', content: doc(para('A claim.'), footnotes('blk_fn', 'The note.')) });
  const note = chunks.find((c) => c.content.includes('The note.'));
  assert.ok(note.blockIds.includes('blk_fn'));
});

test('an empty footnote container contributes nothing', () => {
  assert.deepEqual(docBlocks(doc(para('Body.'), { type: 'footnotes', attrs: { blockId: 'blk_fn' }, content: [] })), [
    { text: 'Body.', level: 0, blockId: null },
  ]);
});
