// The presence palette lives in the client (it is only ever used for rendering)
// but the constraints on it are a product requirement, not a styling detail, so
// they are pinned here where the project actually runs tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENCE_COLORS,
  contrastInk,
  initials,
  pickUserColor,
  relativeLuminance,
  saturation,
  withAlpha,
} from '../../client/src/lib/userColor.js';

test('every presence colour is a well-formed hex triplet', () => {
  for (const color of PRESENCE_COLORS) assert.match(color, /^#[0-9A-F]{6}$/);
});

test('no presence colour is white, black, dark or grey', () => {
  for (const color of PRESENCE_COLORS) {
    const lum = relativeLuminance(color);
    assert.ok(lum > 0.15, `${color} is too dark (luminance ${lum.toFixed(3)})`);
    assert.ok(lum < 0.85, `${color} is too close to white (luminance ${lum.toFixed(3)})`);
    assert.ok(saturation(color) > 0.65, `${color} is not saturated enough to read as a stark colour`);
  }
});

test('presence colours are distinct', () => {
  assert.equal(new Set(PRESENCE_COLORS).size, PRESENCE_COLORS.length);
});

test('a user id always maps to the same colour', () => {
  const id = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  assert.equal(pickUserColor(id), pickUserColor(id));
  assert.ok(PRESENCE_COLORS.includes(pickUserColor(id)));
});

test('different user ids spread across the palette', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `user-${i}-${i * 7919}`);
  const used = new Set(ids.map(pickUserColor));
  assert.equal(used.size, PRESENCE_COLORS.length, 'hash should reach every palette entry');
});

test('label ink contrasts with its colour', () => {
  assert.equal(contrastInk('#FFC400'), '#141414');
  assert.equal(contrastInk('#3B82F6'), '#FFFFFF');
});

test('withAlpha keeps the hue and applies the alpha', () => {
  assert.equal(withAlpha('#FF2D55', 0.25), 'rgba(255, 45, 85, 0.25)');
});

test('initials handle one-word and multi-word names', () => {
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('prince'), 'PR');
  assert.equal(initials('  '), '?');
});
