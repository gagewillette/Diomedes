import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSample, normalizeBatch, routeName, verdict, BUDGETS } from '../src/lib/perf.js';

test('a well-formed sample survives intact', () => {
  const s = normalizeSample({
    kind: 'route',
    name: '/s/:slug/p/:id',
    durationMs: 142.5,
    serverMs: 20,
    transferBytes: 1234,
    status: 200,
  });
  assert.equal(s.kind, 'route');
  assert.equal(s.durationMs, 142.5);
  assert.equal(s.serverMs, 20);
  assert.equal(s.transferBytes, 1234);
  assert.equal(s.status, 200);
});

test('unknown kinds are dropped rather than stored', () => {
  assert.equal(normalizeSample({ kind: 'crypto-miner', durationMs: 1 }), null);
  assert.equal(normalizeSample({ durationMs: 1 }), null);
  assert.equal(normalizeSample(null), null);
  assert.equal(normalizeSample('route'), null);
});

test('vitals and resource rollups need a name to mean anything', () => {
  assert.equal(normalizeSample({ kind: 'vital', name: '', durationMs: 10 }), null);
  assert.equal(normalizeSample({ kind: 'resource', durationMs: 10 }), null);
  // Other kinds are fine unnamed — a long task has no natural name.
  assert.ok(normalizeSample({ kind: 'longtask', durationMs: 90 }));
});

test('hostile numbers are clamped instead of poisoning a percentile', () => {
  // A machine that slept mid-measurement, and a negative from a bad clock.
  assert.equal(normalizeSample({ kind: 'interaction', durationMs: 9e12 }).durationMs, 3_600_000);
  assert.equal(normalizeSample({ kind: 'interaction', durationMs: -5 }).durationMs, 0);
  assert.equal(normalizeSample({ kind: 'interaction', durationMs: NaN }).durationMs, 0);
  assert.equal(normalizeSample({ kind: 'interaction', durationMs: 'fast' }).durationMs, 0);
});

test('a missing server time stays null, not zero', () => {
  // Zero would read as "the server answered instantly", which is a lie the
  // panel would happily average in.
  assert.equal(normalizeSample({ kind: 'api', name: 'x', durationMs: 5 }).serverMs, null);
  assert.equal(normalizeSample({ kind: 'api', name: 'x', durationMs: 5, serverMs: 0 }).serverMs, 0);
});

test('nonsense statuses and detail blobs are refused', () => {
  assert.equal(normalizeSample({ kind: 'api', name: 'x', status: 42 }).status, null);
  assert.equal(normalizeSample({ kind: 'api', name: 'x', status: 200.5 }).status, null);
  assert.deepEqual(normalizeSample({ kind: 'api', name: 'x', detail: [1, 2] }).detail, {});
  assert.deepEqual(normalizeSample({ kind: 'api', name: 'x', detail: { a: 1 } }).detail, { a: 1 });
});

test('long names are truncated so one bad url does not sink a batch', () => {
  const s = normalizeSample({ kind: 'route', name: 'x'.repeat(5000) });
  assert.equal(s.name.length, 200);
});

test('a batch keeps the good samples and caps its own size', () => {
  const batch = normalizeBatch([
    { kind: 'route', name: '/a', durationMs: 10 },
    { kind: 'nope' },
    { kind: 'vital', name: 'lcp', durationMs: 900 },
  ]);
  assert.equal(batch.length, 2);
  assert.deepEqual(
    batch.map((s) => s.name),
    ['/a', 'lcp']
  );
  assert.equal(normalizeBatch(Array(1000).fill({ kind: 'longtask', durationMs: 60 })).length, 200);
  assert.deepEqual(normalizeBatch('samples'), []);
  assert.deepEqual(normalizeBatch(undefined), []);
});

test('route names collapse ids so a thousand page opens aggregate into one row', () => {
  assert.equal(
    routeName('GET', '/api/pages/2f1a9c1e-0f2e-4a7b-9f31-0c4b6b1a2d3e'),
    'GET /api/pages/:id'
  );
  assert.equal(routeName('GET', '/api/pages/123/comments'), 'GET /api/pages/:id/comments');
  assert.equal(routeName('GET', '/api/spaces?limit=5'), 'GET /api/spaces');
  // Share tokens are long opaque strings, and are ids for this purpose.
  assert.equal(routeName('GET', '/api/share/AbCdEfGhIjKlMnOpQrStUv'), 'GET /api/share/:id');
  // Ordinary path segments are left alone.
  assert.equal(routeName('POST', '/api/auth/login'), 'POST /api/auth/login');
});

test('a budget verdict says pass, fail, or nothing at all', () => {
  assert.deepEqual(verdict('interaction', 80), { budget: BUDGETS.interaction, value: 80, ok: true });
  assert.equal(verdict('interaction', 100).ok, true, 'exactly at budget still passes');
  assert.equal(verdict('interaction', 101).ok, false);
  // No samples yet: no verdict, rather than a green badge nothing earned.
  assert.equal(verdict('interaction', null), null);
  assert.equal(verdict('not-a-metric', 5), null);
});
