import test from 'node:test';
import assert from 'node:assert/strict';
import { seedLanded } from './persistence.js';

// Stand-ins for the two things a seed can lose on its way out: the editor and
// the Y.Doc it was writing into. Neither needs to be real — `seedLanded` asks
// them three questions and this file is about the answers.
const fakeYdoc = ({ length = 1, isDestroyed = false } = {}) => ({
  isDestroyed,
  getXmlFragment: () => ({ length }),
});
const fakeEditor = ({ isDestroyed = false } = {}) => ({ isDestroyed });

test('a seed that reached the document counts', () => {
  assert.equal(seedLanded(fakeEditor(), fakeYdoc()), true);
});

test('a seed whose editor was torn down mid-write does not count', () => {
  // The page-switch case: setContent ran, then the editor went away with the
  // route. Reporting this as a seed is what left the page blank for good.
  assert.equal(seedLanded(fakeEditor({ isDestroyed: true }), fakeYdoc()), false);
});

test('a seed whose document was torn down mid-write does not count', () => {
  assert.equal(seedLanded(fakeEditor(), fakeYdoc({ isDestroyed: true })), false);
});

test('an empty document is never a seed, whatever was attempted', () => {
  assert.equal(seedLanded(fakeEditor(), fakeYdoc({ length: 0 })), false);
});

test('nothing to ask means nothing landed', () => {
  assert.equal(seedLanded(null, fakeYdoc()), false);
  assert.equal(seedLanded(fakeEditor(), null), false);
});
