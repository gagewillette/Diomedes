// The normal-mode cursor is drawn as a decoration over the character it sits
// on, and the real caret is transparent — so a cursor that comes to rest past
// the last character of a line is not just wrong by vim's rules, it is
// invisible. The two rules that keep that from happening are arithmetic, so
// they are pinned here alongside the word motions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockCursorAt, eolCursor } from '../../client/src/editor/vim/VimMode.js';

// A stand-in for a ProseMirror document: the helpers only ever ask it for one
// character at a time and for its size.
const docOf = (text) => ({
  content: { size: text.length },
  textBetween: (from, to) => text.slice(from, to),
});

test('a cursor inside the line is left where it is', () => {
  assert.equal(eolCursor(3, 0, 10), 3);
  assert.equal(eolCursor(0, 0, 10), 0);
  assert.equal(eolCursor(9, 0, 10), 9);
});

test('a cursor past the last character is pulled back onto it', () => {
  assert.equal(eolCursor(10, 0, 10), 9);
  assert.equal(eolCursor(25, 0, 10), 9);
});

test('an empty line holds the cursor at its own start', () => {
  assert.equal(eolCursor(4, 4, 4), 4);
  assert.equal(eolCursor(9, 4, 4), 4);
});

test('a position before the line start is pulled forward', () => {
  assert.equal(eolCursor(1, 4, 10), 4);
});

test('the block cursor covers the character under it', () => {
  const doc = docOf('heading');
  assert.deepEqual(blockCursorAt(doc, 2, 0, 7), { type: 'char', from: 2, to: 3 });
});

test('end of line has no character to cover, so it gets a block of its own', () => {
  const doc = docOf('heading');
  assert.deepEqual(blockCursorAt(doc, 7, 0, 7), { type: 'eol', at: 7 });
});

test('an empty line gets the same block, at its start', () => {
  const doc = docOf('');
  assert.deepEqual(blockCursorAt(doc, 0, 0, 0), { type: 'eol', at: 0 });
});

// The reported bug: `j` from a long paragraph into a short heading carries the
// goal column with it, so the landing position is past the end of the heading.
// Before the clamp that left the cursor on nothing at all.
test('j into a shorter line lands on the last character, not past it', () => {
  const HEADING = 'Notes';
  const doc = docOf(HEADING);
  const start = 0;
  const end = HEADING.length;
  const goalColumn = 20; // where the paragraph above was wide enough to reach

  const landed = Math.min(goalColumn, end); // what the geometry probe returns
  assert.equal(blockCursorAt(doc, landed, start, end).type, 'eol');

  const rested = eolCursor(landed, start, end);
  assert.equal(rested, end - 1);
  assert.deepEqual(blockCursorAt(doc, rested, start, end), {
    type: 'char', from: end - 1, to: end,
  });
});
