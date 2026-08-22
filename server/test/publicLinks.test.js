import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedPageIds, pageIdFromHref } from '../src/lib/publicLinks.js';

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const doc = (...content) => ({ type: 'doc', content });
const para = (...content) => ({ type: 'paragraph', content });
const chip = (attrs) => ({ type: 'pageLink', attrs });
const linked = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });

test('pageIdFromHref reads the id out of an in-app page path', () => {
  assert.equal(pageIdFromHref(`/s/design/p/${ID_A}`), ID_A);
  assert.equal(pageIdFromHref(`/s/design/p/${ID_A}#a-heading`), ID_A);
  assert.equal(pageIdFromHref(`/s/design/p/${ID_A}?v=3`), ID_A);
});

test('pageIdFromHref ignores anything that is not a page path', () => {
  assert.equal(pageIdFromHref('https://example.com/s/design/p/' + ID_A), null);
  assert.equal(pageIdFromHref('/s/design'), null);
  assert.equal(pageIdFromHref('/share/sometoken'), null);
  assert.equal(pageIdFromHref('#heading'), null);
  assert.equal(pageIdFromHref(null), null);
});

test('a page id that is not a uuid is never collected', () => {
  // It would reach Postgres as a uuid[] cast and throw there instead.
  assert.equal(pageIdFromHref('/s/design/p/not-a-uuid'), null);
  const found = extractLinkedPageIds(doc(para(chip({ pageId: '1; DROP TABLE pages', label: 'x' }))));
  assert.deepEqual([...found], []);
});

test('extractLinkedPageIds finds chips and plain links, however deeply nested', () => {
  const found = extractLinkedPageIds(
    doc(
      para(chip({ pageId: ID_A, label: 'Roadmap' })),
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(linked('specs', `/s/design/p/${ID_B}#scope`))] },
        ],
      }
    )
  );
  assert.deepEqual([...found].sort(), [ID_A, ID_B].sort());
});

test('the same target linked twice is collected once', () => {
  const found = extractLinkedPageIds(
    doc(para(chip({ pageId: ID_A.toUpperCase(), label: 'Roadmap' }), linked('again', `/s/x/p/${ID_A}`)))
  );
  assert.deepEqual([...found], [ID_A]);
});

test('a document with no links yields nothing', () => {
  assert.deepEqual([...extractLinkedPageIds(doc(para({ type: 'text', text: 'plain' })))], []);
  assert.deepEqual([...extractLinkedPageIds(null)], []);
});
