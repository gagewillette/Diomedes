import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { textNear } from './VimMode.js';

// j/k themselves need a laid-out document — they move by screen line, which is
// a browser measurement. What can be pinned down without one is the step that
// used to strand the cursor: turning the gap around a block that holds no text
// into a position a cursor can sit in.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    horizontalRule: { group: 'block', atom: true, selectable: true },
    text: { group: 'inline' },
  },
});

const p = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
const hr = () => schema.nodes.horizontalRule.create();
const doc = (...nodes) => schema.nodes.doc.create(null, nodes);

test('a position inside a line is already where it needs to be', () => {
  const d = doc(p('alpha'), p('beta'));
  assert.equal(textNear(d, 3, -1), 3);
  assert.equal(textNear(d, 3, 1), 3);
});

test('the gap under a divider resolves up to the line above it, not back down', () => {
  const d = doc(p('alpha'), hr(), p('beta'));
  // 8 is the boundary between the rule and the paragraph below it: the place a
  // `k` out of "beta" lands. Resolving it forwards is what made `k` a dead key
  // — it handed back the very line the cursor was leaving.
  const up = textNear(d, 8, -1);
  assert.equal(d.resolve(up).parent.textContent, 'alpha');
  assert.equal(up, d.resolve(up).end(), 'lands at the end of the line above');
});

test('the same gap resolves down to the line below, so j is unchanged', () => {
  const d = doc(p('alpha'), hr(), p('beta'));
  const down = textNear(d, 7, 1);
  assert.equal(d.resolve(down).parent.textContent, 'beta');
});

test('a divider with nothing above it still yields a position', () => {
  const d = doc(hr(), p('beta'));
  const up = textNear(d, 1, -1);
  assert.equal(d.resolve(up).parent.textContent, 'beta');
});

test('a run of dividers is stepped over in one go', () => {
  const d = doc(p('alpha'), hr(), hr(), p('beta'));
  const up = textNear(d, 9, -1); // the boundary just below the second rule
  assert.equal(d.resolve(up).parent.textContent, 'alpha');
});
