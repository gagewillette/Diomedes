import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, compileQuery, wrapIndex, escapeRegExp, MAX_MATCHES } from './findText.js';

test('literal search ignores regex metacharacters', () => {
  const { matches, error } = findMatches('cost is $1.50 (net)', '$1.50');
  assert.equal(error, null);
  assert.deepEqual(matches, [{ start: 8, end: 13 }]);
});

test('literal search is case-insensitive by default and case-sensitive on request', () => {
  assert.equal(findMatches('Alpha alpha ALPHA', 'alpha').matches.length, 3);
  assert.equal(findMatches('Alpha alpha ALPHA', 'alpha', { caseSensitive: true }).matches.length, 1);
});

test('regex mode compiles the query as a pattern', () => {
  const { matches } = findMatches('colour and color', 'colou?r', { regex: true });
  assert.deepEqual(matches, [{ start: 0, end: 6 }, { start: 11, end: 16 }]);
});

test('invalid regex reports an error instead of throwing', () => {
  const { matches, error } = findMatches('anything', '(unclosed', { regex: true });
  assert.deepEqual(matches, []);
  assert.ok(error && error.length > 0);
});

test('an invalid pattern is harmless in literal mode', () => {
  assert.deepEqual(findMatches('a (unclosed group', '(unclosed').matches, [{ start: 2, end: 11 }]);
});

test('zero-length regex matches cannot loop forever', () => {
  const { matches } = findMatches('aaa', 'b*', { regex: true });
  assert.deepEqual(matches, []);
});

test('match count is capped and flagged as truncated', () => {
  const { matches, truncated } = findMatches('a'.repeat(MAX_MATCHES + 50), 'a');
  assert.equal(matches.length, MAX_MATCHES);
  assert.equal(truncated, true);
});

test('empty query matches nothing', () => {
  assert.deepEqual(findMatches('hello', '').matches, []);
  assert.equal(compileQuery('').re, null);
});

test('wrapIndex cycles in both directions', () => {
  assert.equal(wrapIndex(3, 3), 0);
  assert.equal(wrapIndex(-1, 3), 2);
  assert.equal(wrapIndex(0, 0), -1);
});

test('escapeRegExp neutralises every metacharacter', () => {
  const raw = '.*+?^${}()|[]\\';
  assert.equal(new RegExp(escapeRegExp(raw)).test(raw), true);
});
