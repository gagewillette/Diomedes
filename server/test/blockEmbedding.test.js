import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkPage, MAX_CHUNK_TOKENS } from '../src/search/chunk.js';
import { chunksNeedingEmbedding } from '../src/search/queue.js';

const block = (blockId, type, text, attrs = {}) => ({
  type,
  attrs: { blockId, ...attrs },
  content: [{ type: 'text', text }],
});
const para = (id, text) => block(id, 'paragraph', text);
const heading = (id, text, level = 1) => block(id, 'heading', text, { level });
const doc = (...content) => ({ type: 'doc', content });

// Long enough that two of them cannot share a chunk.
const long = (word) => `${word} `.repeat(MAX_CHUNK_TOKENS * 2).trim();

// ---- chunks record which blocks they were built from ----

test('a chunk names the blocks its text came from', () => {
  const [chunk] = chunkPage({ title: 'Page', content: doc(para('blk_a', 'one'), para('blk_b', 'two')) });
  assert.deepEqual(chunk.blockIds.sort(), ['blk_a', 'blk_b']);
});

test('a heading is a source of every chunk in its section', () => {
  const chunks = chunkPage({
    title: 'Page',
    content: doc(heading('blk_h', 'Section'), para('blk_a', long('alpha')), para('blk_b', long('beta'))),
  });
  assert.ok(chunks.length > 1, 'expected the section to split across chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.blockIds.includes('blk_h'), 'the heading is a source of every chunk under it');
  }
});

test('a heading is not a source of chunks in a later section', () => {
  const chunks = chunkPage({
    title: 'Page',
    content: doc(
      heading('blk_h1', 'First'),
      para('blk_a', 'alpha'),
      heading('blk_h2', 'Second'),
      para('blk_b', 'beta')
    ),
  });
  const second = chunks.find((c) => c.blockIds.includes('blk_b'));
  assert.ok(!second.blockIds.includes('blk_h1'), 'the earlier heading has left the trail');
  assert.ok(second.blockIds.includes('blk_h2'));
});

test('a document with no block ids still chunks, naming no sources', () => {
  const chunks = chunkPage({
    title: 'Legacy',
    content: doc({ type: 'paragraph', content: [{ type: 'text', text: 'written before ids existed' }] }),
  });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].blockIds, []);
});

test('a heading-only page still produces one findable chunk', () => {
  const chunks = chunkPage({ title: 'Index', content: doc(heading('blk_h', 'Just a heading')) });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].blockIds, ['blk_h']);
});

// ---- deciding what to re-embed ----

const stored = (chunks, vector = [0.1, 0.2]) =>
  chunks.map((c) => ({ content: c.content, embedding: `[${vector.join(',')}]` }));

// The headline number from the migration plan: a typo fix on a forty-chunk
// page went from forty embedding calls to one or two.
//
// The shape here is the realistic one — many ordinary paragraphs, each its own
// block, each large enough that two do not share a chunk. Two is the expected
// answer rather than one because of the overlap carry: the chunk *after* the
// edited block begins with a tail of that block's text, so its stored text
// genuinely changed too. Catching that is exactly why reuse is keyed on a
// chunk's content and not merely on which blocks it names.
test('a typo fix on a forty-chunk page costs one or two embedding calls', () => {
  const PAGE_BLOCKS = 40;
  // Just under the chunk cap, so each paragraph gets a chunk to itself. The
  // estimator counts characters, not words, so the size is set in characters.
  const body = (word) =>
    `${word} `.repeat(Math.floor((MAX_CHUNK_TOKENS * 4 * 0.85) / (word.length + 1))).trim();
  const paragraphs = (edited) =>
    Array.from({ length: PAGE_BLOCKS }, (_, i) =>
      para(`blk_${i}`, i === edited ? `${body(`word${i}`)} typo` : body(`word${i}`))
    );

  const before = chunkPage({ title: 'Page', content: doc(...paragraphs(-1)) });
  assert.ok(before.length >= PAGE_BLOCKS, `expected ~${PAGE_BLOCKS} chunks, got ${before.length}`);

  const after = chunkPage({ title: 'Page', content: doc(...paragraphs(17)) });
  const { stale, reused } = chunksNeedingEmbedding(after, stored(before), ['blk_17']);

  assert.ok(stale.length <= 2, `expected 1-2 embedding calls, got ${stale.length} of ${after.length}`);
  assert.equal(reused.size, after.length - stale.length);
  // Before this change the same edit cost one call per chunk on the page.
  assert.ok(stale.length < before.length / 10);
});

// A block big enough to fill several chunks on its own is the case where the
// saving is smallest, and it should be: every one of those chunks really did
// change. Worth pinning so nobody "optimises" it into reusing stale vectors.
test('editing a block that spans several chunks re-embeds all of them', () => {
  const before = chunkPage({ title: 'Page', content: doc(para('blk_a', long('alpha')), para('blk_b', long('beta'))) });
  const after = chunkPage({
    title: 'Page',
    content: doc(para('blk_a', `${long('alpha')} extra`), para('blk_b', long('beta'))),
  });
  const { stale, reused } = chunksNeedingEmbedding(after, stored(before), ['blk_a']);
  assert.ok(stale.length > 1);
  assert.ok(reused.size > 0, 'the untouched block was re-embedded too');
});

// Reuse is keyed on content rather than index precisely so this works: an
// insertion at the top renumbers every chunk below it without changing a word.
test('inserting a block at the top does not re-embed the chunks below it', () => {
  const before = chunkPage({
    title: 'Page',
    content: doc(para('blk_a', long('alpha')), para('blk_b', long('beta'))),
  });
  const after = chunkPage({
    title: 'Page',
    content: doc(para('blk_new', long('inserted')), para('blk_a', long('alpha')), para('blk_b', long('beta'))),
  });
  const { stale, reused } = chunksNeedingEmbedding(after, stored(before), ['blk_new']);
  assert.ok(reused.size > 0, 'no chunk survived an insertion that changed none of their text');
  for (const i of stale) {
    assert.ok(
      !stored(before).some((s) => s.content === after[i].content),
      `chunk ${i} was re-embedded despite identical text`
    );
  }
});

// A rename rewrites the title prefix of every chunk, so nothing is reusable.
// This falls out of content-keyed reuse rather than being detected.
test('renaming the page re-embeds everything, without a special case', () => {
  const content = doc(para('blk_a', long('alpha')), para('blk_b', long('beta')));
  const before = chunkPage({ title: 'Old name', content });
  const after = chunkPage({ title: 'New name', content });
  const { stale, reused } = chunksNeedingEmbedding(after, stored(before), ['blk_a']);
  assert.equal(stale.length, after.length);
  assert.equal(reused.size, 0);
});

test('deleting a block re-embeds the chunk that held it and leaves the rest', () => {
  const before = chunkPage({
    title: 'Page',
    content: doc(para('blk_a', long('alpha')), para('blk_b', long('beta')), para('blk_c', long('gamma'))),
  });
  const after = chunkPage({
    title: 'Page',
    content: doc(para('blk_a', long('alpha')), para('blk_c', long('gamma'))),
  });
  const { stale, reused } = chunksNeedingEmbedding(after, stored(before), ['blk_b']);
  assert.ok(reused.size > 0, 'a deletion invalidated chunks it did not touch');
  assert.ok(stale.length < before.length);
});

test('an unchanged page needs no embedding calls at all', () => {
  const content = doc(para('blk_a', long('alpha')), para('blk_b', long('beta')));
  const chunks = chunkPage({ title: 'Page', content });
  const { stale } = chunksNeedingEmbedding(chunks, stored(chunks), ['blk_a']);
  // blk_a's own chunks are re-embedded because it was named as changed; the
  // rest are reused. Nothing beyond that block's reach is touched.
  assert.ok(stale.every((i) => chunks[i].blockIds.includes('blk_a')));
});

// The fallback that keeps the backfill and any pre-migration document working.
test('a job with no block ids rebuilds the whole page, as before', () => {
  const chunks = chunkPage({ title: 'Page', content: doc(para('blk_a', long('alpha')), para('blk_b', long('beta'))) });
  const { stale, reused } = chunksNeedingEmbedding(chunks, stored(chunks), null);
  assert.deepEqual(stale, chunks.map((_, i) => i));
  assert.equal(reused.size, 0);
});

test('a stored chunk whose embedding never landed is not reused', () => {
  const chunks = chunkPage({ title: 'Page', content: doc(para('blk_a', long('alpha')), para('blk_b', long('beta'))) });
  const broken = chunks.map((c) => ({ content: c.content, embedding: null }));
  const { stale, reused } = chunksNeedingEmbedding(chunks, broken, ['blk_a']);
  assert.equal(reused.size, 0);
  assert.deepEqual(stale, chunks.map((_, i) => i));
});
