import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, normalizeTitle, pickTitleMatch } from '../src/lib/links.js';

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

// ---- resolve-titles ----

const inSpace = (id, space_id) => ({ id, space_id, title: 'Overview' });

test('one page with the title resolves to it', () => {
  assert.deepEqual(pickTitleMatch([inSpace('p1', 's1')], 's1'), {
    status: 'ok',
    page: inSpace('p1', 's1'),
  });
});

test('a title nothing carries is not found', () => {
  assert.deepEqual(pickTitleMatch([], 's1'), { status: 'not_found' });
  assert.deepEqual(pickTitleMatch(undefined, 's1'), { status: 'not_found' });
});

test('the space the link was written in wins over identical titles elsewhere', () => {
  const match = pickTitleMatch([inSpace('p1', 's2'), inSpace('p2', 's1')], 's1');
  assert.equal(match.status, 'ok');
  assert.equal(match.page.id, 'p2');
});

test('a title only found in another space still resolves', () => {
  const match = pickTitleMatch([inSpace('p1', 's2')], 's1');
  assert.equal(match.status, 'ok');
  assert.equal(match.page.id, 'p1');
});

test('two pages sharing a title in the same space are reported, not guessed', () => {
  const match = pickTitleMatch([inSpace('p1', 's1'), inSpace('p2', 's1')], 's1');
  assert.equal(match.status, 'ambiguous');
  assert.deepEqual(match.candidates.map((p) => p.id), ['p1', 'p2']);
});

test('with no space to prefer, any tie at all is ambiguous', () => {
  const match = pickTitleMatch([inSpace('p1', 's1'), inSpace('p2', 's2')], null);
  assert.equal(match.status, 'ambiguous');
  assert.equal(match.candidates.length, 2);
});
