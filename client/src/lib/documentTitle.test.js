import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTitle, normalizeIcon, faviconHref, DEFAULT_TITLE, DEFAULT_ICON,
} from './documentTitle.js';

test('an untitled or missing name falls back to the app name', () => {
  assert.equal(formatTitle(''), DEFAULT_TITLE);
  assert.equal(formatTitle('   '), DEFAULT_TITLE);
  assert.equal(formatTitle(undefined), DEFAULT_TITLE);
  assert.equal(formatTitle(null), DEFAULT_TITLE);
});

test('a name is trimmed and kept as-is', () => {
  assert.equal(formatTitle('  Release notes  '), 'Release notes');
});

test('a very long name is cut so the tab stays readable', () => {
  const title = formatTitle('x'.repeat(200));
  assert.equal(title.length, 80);
  assert.ok(title.endsWith('…'));
});

test('an emoji icon is used, including multi-code-point ones', () => {
  assert.equal(normalizeIcon('🚀'), '🚀');
  assert.equal(normalizeIcon(' 📕 '), '📕');
  assert.equal(normalizeIcon('❤️'), '❤️'); // emoji + variation selector
  assert.equal(normalizeIcon('👩‍💻'), '👩‍💻'); // ZWJ sequence
});

test('a missing or non-emoji icon falls back to the default', () => {
  assert.equal(normalizeIcon(''), DEFAULT_ICON);
  assert.equal(normalizeIcon(null), DEFAULT_ICON);
  assert.equal(normalizeIcon('Notes'), DEFAULT_ICON);
  assert.equal(normalizeIcon('🚀 launch day'), DEFAULT_ICON);
});

test('the favicon is a self-contained encoded SVG data URI', () => {
  const href = faviconHref('🚀');
  assert.ok(href.startsWith('data:image/svg+xml,'));
  const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
  assert.ok(svg.includes('🚀'));
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  // Nothing raw made it into the URL itself.
  assert.ok(!/[^\x21-\x7e]/.test(href));
});

test('an icon that is markup cannot break out of the SVG', () => {
  const svg = decodeURIComponent(faviconHref('<>').slice('data:image/svg+xml,'.length));
  assert.ok(!svg.includes('<text y=".9em" font-size="90"><>'));
  assert.ok(svg.includes('&#60;&#62;'));
});
