import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPublicShareView,
  clearPublicShareView,
  inPublicShareView,
  publicShareHref,
  publicShareHrefFor,
} from './publicShare.js';

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test.afterEach(() => clearPublicShareView());

test('nothing is public until a share view says otherwise', () => {
  assert.equal(inPublicShareView(), false);
  assert.equal(publicShareHref(ID_A), null);
  assert.equal(publicShareHrefFor(`/s/design/p/${ID_A}`), null);
});

test('a linked public page routes to its own share link', () => {
  setPublicShareView('tok-here', { [ID_A]: 'tok-there' });
  assert.equal(inPublicShareView(), true);
  assert.equal(publicShareHref(ID_A), '/share/tok-there');
});

test('a private target is left alone, so the login screen still does its job', () => {
  setPublicShareView('tok-here', { [ID_A]: 'tok-there' });
  assert.equal(publicShareHref(ID_B), null);
  assert.equal(publicShareHrefFor(`/s/design/p/${ID_B}`), null);
});

test('an in-app page href is rewritten, keeping the anchor that followed it', () => {
  setPublicShareView('tok-here', { [ID_A]: 'tok-there' });
  assert.equal(publicShareHrefFor(`/s/design/p/${ID_A}`), '/share/tok-there');
  assert.equal(publicShareHrefFor(`/s/design/p/${ID_A}#scope`), '/share/tok-there#scope');
  assert.equal(publicShareHrefFor(`/s/design/p/${ID_A.toUpperCase()}?v=2`), '/share/tok-there?v=2');
});

test('hrefs that are not in-app page paths are ignored', () => {
  setPublicShareView('tok-here', { [ID_A]: 'tok-there' });
  assert.equal(publicShareHrefFor(`https://example.com/s/design/p/${ID_A}`), null);
  assert.equal(publicShareHrefFor('/s/design'), null);
  assert.equal(publicShareHrefFor('#heading'), null);
  assert.equal(publicShareHrefFor(undefined), null);
});

test('a payload from a server that does not send the map still renders', () => {
  setPublicShareView('tok-here', undefined);
  assert.equal(inPublicShareView(), true);
  assert.equal(publicShareHref(ID_A), null);
});

test('leaving the share view forgets every token', () => {
  setPublicShareView('tok-here', { [ID_A]: 'tok-there' });
  clearPublicShareView();
  assert.equal(inPublicShareView(), false);
  assert.equal(publicShareHref(ID_A), null);
});
