import test from 'node:test';
import assert from 'node:assert/strict';
import { screenName, apiName, parseServerTiming, shouldSample } from '../src/lib/perf.js';
import { formatBytes, formatMs, formatCount, formatDuration } from '../src/lib/format.js';

test('screen names collapse ids so every page open lands in one bucket', () => {
  assert.equal(screenName('/'), '/');
  assert.equal(screenName('/s/engineering'), '/s/:slug');
  assert.equal(screenName('/s/engineering/p/2f1a9c1e-0f2e-4a7b-9f31-0c4b6b1a2d3e'), '/s/:slug/p/:id');
  assert.equal(screenName('/settings/workspace/info'), '/settings/workspace/info');
  assert.equal(screenName('/settings/members'), '/settings/members');
  assert.equal(screenName('/share/AbCdEf012345'), '/share/:id');
  assert.equal(screenName('/s/docs?x=1'), '/s/:slug');
});

test('api names strip ids the same way', () => {
  assert.equal(apiName('GET', '/api/pages/2f1a9c1e-0f2e-4a7b-9f31-0c4b6b1a2d3e'), 'GET /api/pages/:id');
  assert.equal(apiName('GET', '/api/spaces?limit=10'), 'GET /api/spaces');
  assert.equal(apiName('POST', '/api/auth/login'), 'POST /api/auth/login');
});

test('Server-Timing is read when present and null when it is not', () => {
  assert.equal(parseServerTiming('app;dur=12.4'), 12.4);
  assert.equal(parseServerTiming('cache;desc="hit", app;dur=3.5'), 3.5);
  // No header, no split — the sample must not claim the server took 0ms.
  assert.equal(parseServerTiming(null), null);
  assert.equal(parseServerTiming(''), null);
  assert.equal(parseServerTiming('cdn-cache;desc=HIT'), null);
  assert.equal(parseServerTiming('app;dur=nonsense'), null);
});

test('sampling keeps everything at 100% and nothing at 0%', () => {
  assert.equal(shouldSample('interaction', 1, 0.99), true);
  assert.equal(shouldSample('interaction', 0, 0.0), false);
});

test('page opens and vitals bypass the sample rate', () => {
  // There are only a handful of these per load; dropping them leaves the
  // panel with no page-open numbers at all.
  assert.equal(shouldSample('vital', 0.1, 0.99), true);
  assert.equal(shouldSample('route', 0.1, 0.99), true);
  assert.equal(shouldSample('navigation', 0.1, 0.99), true);
  // High-volume kinds are thinned.
  assert.equal(shouldSample('interaction', 0.1, 0.99), false);
  assert.equal(shouldSample('interaction', 0.1, 0.05), true);
  assert.equal(shouldSample('resource', 0.5, 0.4), true);
  assert.equal(shouldSample('resource', 0.5, 0.6), false);
});

test('bytes read the way a person would say them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(2_500_000), '2.5 MB');
  assert.equal(formatBytes(3_200_000_000), '3.2 GB');
});

test('durations switch units instead of printing four-digit milliseconds', () => {
  assert.equal(formatMs(null), '—');
  assert.equal(formatMs(undefined), '—');
  assert.equal(formatMs(0.42), '0.42 ms');
  assert.equal(formatMs(12.34), '12.3 ms');
  assert.equal(formatMs(340.7), '341 ms');
  assert.equal(formatMs(1543), '1.54 s');
  assert.equal(formatMs(90_000), '1.5 min');
  // CLS is a score, not a time.
  assert.equal(formatMs(0.0812, { unit: 'score' }), '0.081');
});

test('counts and uptimes', () => {
  assert.equal(formatCount(12345), (12345).toLocaleString());
  assert.equal(formatCount('nope'), '—');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(600), '10m');
  assert.equal(formatDuration(7200), '2.0h');
  assert.equal(formatDuration(172_800), '2.0d');
  assert.equal(formatDuration(-1), '—');
});
