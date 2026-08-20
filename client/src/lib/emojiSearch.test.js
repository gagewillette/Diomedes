import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeEmoji, rankEmoji } from './emojiSearch.js';

// The generated index is read from disk rather than imported, so this test does
// not need the bundler's JSON handling.
const index = JSON.parse(
  readFileSync(fileURLToPath(new URL('./emojiIndex.json', import.meta.url)), 'utf8'),
);
const EMOJI = index.emoji;

test('the generated sheet covers the whole grid it claims to', () => {
  assert.ok(EMOJI.length > 1500, `only ${EMOJI.length} emoji in the sheet`);
  for (const e of EMOJI) {
    assert.ok(e.x >= 0 && e.x < index.cols, `column ${e.x} out of range for ${e.n}`);
    assert.ok(e.y >= 0 && e.y < index.rows, `row ${e.y} out of range for ${e.n}`);
    assert.ok(e.g >= 0 && e.g < index.categories.length, `category ${e.g} out of range`);
  }
  // Two emoji sharing a cell would silently draw the wrong picture.
  const cells = new Set(EMOJI.map((e) => `${e.x},${e.y}`));
  assert.equal(cells.size, EMOJI.length);
});

test('an empty query keeps the grid in its category order', () => {
  assert.equal(rankEmoji(EMOJI, '   '), EMOJI);
});

test('a shortcode prefix outranks a word buried in a name', () => {
  const [first] = rankEmoji(EMOJI, 'heart');
  assert.ok(first.k.split(' ').some((k) => k.startsWith('heart')), `got ${first.n}`);
});

test('every term has to match', () => {
  const both = rankEmoji(EMOJI, 'smiling cat');
  assert.ok(both.length > 0);
  for (const e of both) {
    assert.ok(`${e.n} ${e.k}`.includes('smiling'));
    assert.ok(`${e.n} ${e.k}`.includes('cat'));
  }
  assert.deepEqual(rankEmoji(EMOJI, 'zzzznotanemoji'), []);
});

test('the subcategory is searchable, so archaic Unicode names still turn up', () => {
  // The dataset calls this one "heavy black heart"; nobody types that.
  const hits = rankEmoji(EMOJI, 'heart');
  assert.ok(hits.some((e) => e.n === 'heavy black heart'), 'plain heart not reachable');
});

test('search is case-insensitive', () => {
  assert.deepEqual(
    rankEmoji(EMOJI, 'ROCKET').map((e) => e.c),
    rankEmoji(EMOJI, 'rocket').map((e) => e.c),
  );
});

test('a variation selector still resolves to the sheet entry', () => {
  const withSelector = '❤️'; // heavy black heart as most keyboards send it
  const bare = normalizeEmoji(withSelector);
  assert.equal(bare, '❤');
  assert.ok(
    EMOJI.some((e) => e.c === bare || normalizeEmoji(e.c) === bare),
    'no sheet entry for the bare heart',
  );
});
