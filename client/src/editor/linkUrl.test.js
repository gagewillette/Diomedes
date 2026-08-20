import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isValidUrl, isExternalUrl, linkHost, linkSafety } from './linkUrl.js';

test('keeps a full URL as typed', () => {
  assert.equal(normalizeUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com');
  assert.equal(normalizeUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
});

test('adds https:// to a bare host', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('  example.com/docs  '), 'https://example.com/docs');
});

test('leaves in-app paths and anchors alone', () => {
  assert.equal(normalizeUrl('/s/eng/p/abc'), '/s/eng/p/abc');
  assert.equal(normalizeUrl('#section-2'), '#section-2');
});

test('rejects script-bearing and unknown schemes', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    assert.equal(normalizeUrl(bad), '', bad);
    assert.equal(isValidUrl(bad), false, bad);
  }
});

test('rejects a scheme hidden behind control characters', () => {
  assert.equal(normalizeUrl('java\u0000script:alert(1)'), '');
  assert.equal(normalizeUrl('java\tscript:alert(1)'), '');
  assert.equal(normalizeUrl('java\nscript:alert(1)'), '');
});

test('rejects empty and prose input', () => {
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('   '), '');
  assert.equal(normalizeUrl(null), '');
  assert.equal(normalizeUrl(undefined), '');
  assert.equal(normalizeUrl('see the docs page'), '');
});

test('external is anything that leaves the wiki', () => {
  assert.equal(isExternalUrl('example.com'), true);
  assert.equal(isExternalUrl('https://example.com'), true);
  assert.equal(isExternalUrl('mailto:a@b.com'), true);
  assert.equal(isExternalUrl('/s/eng/p/abc'), false);
  assert.equal(isExternalUrl('#top'), false);
  assert.equal(isExternalUrl('javascript:alert(1)'), false);
});

test('host is what a reader checks before trusting a link', () => {
  assert.equal(linkHost('https://docs.example.com/a/b'), 'docs.example.com');
  assert.equal(linkHost('example.com'), 'example.com');
  assert.equal(linkHost('mailto:someone@example.com'), 'someone@example.com');
  assert.equal(linkHost('/s/eng/p/abc'), '');
  assert.equal(linkHost('javascript:alert(1)'), '');
});

test('safety: an ordinary https address is safe', () => {
  assert.equal(linkSafety('https://example.com/a').level, 'safe');
  assert.equal(linkSafety('example.com').level, 'safe');
  assert.equal(linkSafety('/s/eng/p/abc').level, 'safe');
  assert.equal(linkSafety('#top').level, 'safe');
  assert.equal(linkSafety('mailto:a@b.com').level, 'safe');
});

test('safety: credentials before the @ are deceptive', () => {
  const verdict = linkSafety('https://docs.google.com@evil.example/login');
  assert.equal(verdict.level, 'unsafe');
  assert.match(verdict.reason, /evil\.example/);
});

test('safety: punycode hosts can imitate a familiar name', () => {
  assert.equal(linkSafety('https://xn--80ak6aa92e.com').level, 'unsafe');
  assert.equal(linkSafety('https://login.xn--80ak6aa92e.com').level, 'unsafe');
});

test('safety: a refused scheme reports as unsafe rather than throwing', () => {
  assert.equal(linkSafety('javascript:alert(1)').level, 'unsafe');
  assert.equal(linkSafety('').level, 'unsafe');
});

test('safety: worth-a-second-look links are caution, not unsafe', () => {
  assert.equal(linkSafety('http://example.com').level, 'caution');
  assert.equal(linkSafety('https://bit.ly/abc').level, 'caution');
  assert.equal(linkSafety('https://192.168.1.10/admin').level, 'caution');
  assert.equal(linkSafety('https://example.com:8443/a').level, 'caution');
});

test('safety: every verdict carries something to show the reader', () => {
  for (const url of ['https://example.com', 'http://example.com', 'javascript:alert(1)', '/s/eng/p/a']) {
    const verdict = linkSafety(url);
    assert.ok(verdict.label, url);
    assert.ok(verdict.reason, url);
    assert.ok(['safe', 'caution', 'unsafe'].includes(verdict.level), url);
  }
});
