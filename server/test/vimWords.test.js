// The word motions are the part of the vim emulation that is pure arithmetic
// over document text, so they can be pinned here even though they live in the
// client. Everything else in VimMode needs a laid-out browser to mean anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  charAt, wordAt, wordBackward, wordEnd, wordForward,
} from '../../client/src/editor/vim/VimMode.js';

// A stand-in for a single-textblock ProseMirror document: the motions only
// ever ask it for one character at a time and for its size.
const docOf = (text) => ({
  content: { size: text.length },
  textBetween: (from, to) => text.slice(from, to),
});

//            0123456789...
const CODE = 'foo.bar(baz) qux-quux, hello';
const doc = docOf(CODE);

test('charAt stops at the end of the document', () => {
  assert.equal(charAt(doc, 0), 'f');
  assert.equal(charAt(doc, CODE.length), '');
  assert.equal(charAt(doc, -1), '');
});

test('w stops at punctuation, W runs past it', () => {
  assert.equal(wordForward(doc, 0), CODE.indexOf('.'));
  assert.equal(wordForward(doc, 0, true), CODE.indexOf('qux'));
  // Repeated w picks its way through foo . bar ( baz ) one piece at a time.
  let p = 0;
  const stops = [];
  for (let i = 0; i < 6; i += 1) { p = wordForward(doc, p); stops.push(p); }
  assert.deepEqual(stops, [3, 4, 7, 8, 11, 13]);
});

test('b steps back one piece, B steps back a whole WORD', () => {
  const qux = CODE.indexOf('qux');
  assert.equal(wordBackward(doc, qux), CODE.indexOf(')'));
  assert.equal(wordBackward(doc, qux, true), 0);
  // From inside `quux`, B goes to the start of `qux-quux,`.
  assert.equal(wordBackward(doc, CODE.indexOf('quux') + 2, true), qux);
});

test('e lands on the last character, E on the last of the WORD', () => {
  assert.equal(wordEnd(doc, 0), 2); // foo
  assert.equal(wordEnd(doc, 0, true), CODE.indexOf(')'));
  assert.equal(wordEnd(doc, CODE.indexOf('qux') - 1, true), CODE.indexOf(','));
});

test('the WORD motions are the ones that clear punctuation in one jump', () => {
  // The bug this pins: B and E used to be unbound, so `foo.bar(baz)` could
  // only be crossed one bracket at a time.
  const close = CODE.indexOf(')');
  assert.notEqual(wordBackward(doc, close, true), wordBackward(doc, close));
  assert.notEqual(wordEnd(doc, 0, true), wordEnd(doc, 0));
});

test('wordAt spans the word under the cursor, either flavour', () => {
  assert.deepEqual(wordAt(doc, 1), { from: 0, to: 3, blank: false });
  assert.deepEqual(wordAt(doc, 1, true), { from: 0, to: 12, blank: false });
  // On a space, iw is the run of whitespace.
  const space = CODE.indexOf(' ');
  assert.deepEqual(wordAt(doc, space), { from: space, to: space + 1, blank: true });
});
