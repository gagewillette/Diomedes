import test from 'node:test';
import assert from 'node:assert/strict';

// pageLabels reaches the app's pub/sub, which is `window` under the browser.
// Stubbed before the import so the module can be loaded outside one.
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const calls = [];
let respond = () => ({ results: {} });

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  const payload = respond(body);
  if (payload instanceof Error) throw payload;
  const raw = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => raw,
  };
};

const { subscribeLabel, clearLabelCache, normalizeLabel } = await import('./pageLabels.js');

// Subscriptions resolve on a microtask; this waits for the request to land.
const settled = () => new Promise((r) => setTimeout(r, 0));

const resolveTo = (map) => (body) => ({
  results: Object.fromEntries(body.titles.map((t) => [t, map[t] || { status: 'not_found' }])),
});

const page = (id, title) => ({ status: 'ok', id, title, icon: null, space_slug: 'eng' });

// Every subscription is dropped between tests: a live one would be re-asked
// by the next test's cache clear and show up as a stray request.
const stops = [];
const sub = (spaceId, label, cb) => {
  const stop = subscribeLabel(spaceId, label, cb);
  stops.push(stop);
  return stop;
};

test.beforeEach(() => {
  calls.length = 0;
  clearLabelCache();
});

test.afterEach(async () => {
  while (stops.length) stops.pop()();
  clearLabelCache();
  await settled();
});

test('a document full of unresolved links costs one request per space', async () => {
  respond = resolveTo({ architecture: page('p1', 'Architecture'), 'auth service': page('p2', 'Auth Service') });
  const seen = {};
  sub('space-a', 'Architecture', (v) => (seen.arch = v));
  sub('space-a', 'Auth Service', (v) => (seen.auth = v));
  sub('space-b', 'Architecture', (v) => (seen.other = v));
  await settled();

  assert.equal(calls.length, 2, 'one request per space, not one per link');
  assert.deepEqual(
    calls.map((c) => c.body.spaceId),
    ['space-a', 'space-b']
  );
  assert.deepEqual(calls[0].body.titles.sort(), ['architecture', 'auth service']);
  assert.equal(seen.arch.id, 'p1');
  assert.equal(seen.auth.id, 'p2');
});

test('case and inner whitespace do not make a second lookup', async () => {
  respond = resolveTo({ architecture: page('p1', 'Architecture') });
  let a;
  let b;
  sub('space-a', '  ARCHITECTURE ', (v) => (a = v));
  await settled();
  sub('space-a', 'architecture', (v) => (b = v));
  await settled();

  assert.equal(calls.length, 1);
  assert.equal(a.id, 'p1');
  assert.equal(b.id, 'p1', 'answered from cache, same normalized title');
  assert.equal(normalizeLabel('  Design   Docs '), 'design docs');
});

test('a title no page has stays unresolved', async () => {
  respond = resolveTo({});
  let seen = 'unset';
  sub('space-a', 'Not Written Yet', (v) => (seen = v));
  await settled();
  assert.equal(seen, null);
});

test('an ambiguous title stays unresolved rather than guessing', async () => {
  respond = (body) => ({
    results: {
      [body.titles[0]]: {
        status: 'ambiguous',
        candidates: [page('p1', 'Overview'), page('p2', 'Overview')],
      },
    },
  });
  let seen = 'unset';
  sub('space-a', 'Overview', (v) => (seen = v));
  await settled();
  assert.equal(seen, null, 'two pages claim the title; pointing at one would be a guess');
});

test('a failed lookup is not remembered as "no such page"', async () => {
  respond = () => new Error('offline');
  let seen = 'unset';
  sub('space-a', 'Architecture', (v) => (seen = v));
  await settled();
  assert.equal(seen, 'unset', 'no callback, so the chip keeps showing its written label');

  respond = resolveTo({ architecture: page('p1', 'Architecture') });
  sub('space-a', 'Architecture', (v) => (seen = v));
  await settled();
  assert.equal(seen.id, 'p1', 'the next render retries instead of taking a cached miss');
});

test('writing the page a gray link names re-resolves it', async () => {
  respond = resolveTo({});
  let seen = 'unset';
  sub('space-a', 'Architecture', (v) => (seen = v));
  await settled();
  assert.equal(seen, null);

  respond = resolveTo({ architecture: page('p1', 'Architecture') });
  clearLabelCache(); // what a 'pages-changed' event triggers
  await settled();
  assert.equal(seen.id, 'p1', 'the link heals without the document being rewritten');
});

test('unsubscribing stops the re-resolution sweep from asking again', async () => {
  respond = resolveTo({});
  const stop = sub('space-a', 'Architecture', () => {});
  await settled();
  stop();
  calls.length = 0;
  clearLabelCache();
  await settled();
  assert.equal(calls.length, 0);
});
