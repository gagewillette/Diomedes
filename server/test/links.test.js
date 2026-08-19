import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, normalizeTitle } from '../src/lib/links.js';

const doc = (...content) => ({ type: 'doc', content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t) => ({ type: 'text', text: t });
const link = (attrs) => ({ type: 'pageLink', attrs });

test('extractLinks finds links nested anywhere in the document', () => {
  const found = extractLinks(
    doc(
      para(text('see '), link({ pageId: 'p1', label: 'Roadmap' })),
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [para(text('and '), link({ pageId: 'p2', label: 'Specs' }))],
          },
        ],
      }
    )
  );
  assert.deepEqual(found, [
    { pageId: 'p1', label: 'Roadmap' },
    { pageId: 'p2', label: 'Specs' },
  ]);
});

test('extractLinks keeps unresolved links, which carry a title but no id', () => {
  const found = extractLinks(doc(para(link({ pageId: null, label: 'Not Written Yet' }))));
  assert.deepEqual(found, [{ pageId: null, label: 'Not Written Yet' }]);
});

test('extractLinks ignores link nodes with neither an id nor a label', () => {
  assert.deepEqual(extractLinks(doc(para(link({ pageId: null, label: '   ' })))), []);
});

test('extractLinks ignores user mentions and ordinary text', () => {
  const found = extractLinks(
    doc(para(text('hi '), { type: 'mention', attrs: { id: 'u1', label: 'Ada' } }))
  );
  assert.deepEqual(found, []);
});

test('extractLinks survives empty and malformed documents', () => {
  assert.deepEqual(extractLinks(null), []);
  assert.deepEqual(extractLinks({}), []);
  assert.deepEqual(extractLinks(doc()), []);
});

test('normalizeTitle makes case and inner whitespace irrelevant', () => {
  assert.equal(normalizeTitle('  Design   Docs '), 'design docs');
  assert.equal(normalizeTitle('Design Docs'), normalizeTitle('design  docs'));
  assert.equal(normalizeTitle(null), '');
});
