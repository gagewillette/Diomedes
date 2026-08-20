import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { nextRenderId, removeRenderScratch } from './mermaidRender.js';

const scratchDom = (...ids) => {
  const dom = new JSDOM(
    `<!doctype html><html><body>${ids.map((id) => `<div id="d${id}"></div>`).join('')}</body></html>`
  );
  return dom.window.document;
};

test('render ids are never handed out twice', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(nextRenderId());
  assert.equal(ids.size, 50);
});

test('a failed render clears its own scratch element', () => {
  const id = nextRenderId();
  const doc = scratchDom(id);
  removeRenderScratch(id, doc);
  assert.equal(doc.getElementById(`d${id}`), null);
});

// The regression: two diagrams on a page render at once, and the broken one
// throws after the good one has already taken the next id. Cleaning up by
// "current counter" removed the good diagram's scratch element mid-render and
// blanked it. The id has to be the one this render was started with.
test('a failed render leaves a concurrent render alone', () => {
  const broken = nextRenderId();
  const good = nextRenderId();
  const doc = scratchDom(broken, good);
  removeRenderScratch(broken, doc);
  assert.equal(doc.getElementById(`d${broken}`), null);
  assert.ok(doc.getElementById(`d${good}`), 'the concurrent render kept its element');
});

test('cleanup is a no-op without an id or a document', () => {
  const doc = scratchDom('gd-mermaid-1');
  removeRenderScratch('', doc);
  removeRenderScratch(null, doc);
  assert.ok(doc.getElementById('dgd-mermaid-1'));
  assert.doesNotThrow(() => removeRenderScratch('gd-mermaid-1', null));
});
