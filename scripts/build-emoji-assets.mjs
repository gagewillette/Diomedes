#!/usr/bin/env node
// Builds the Apple emoji sprite sheet and index that the client ships.
//
// Every platform has to draw the same glyph, so we cannot lean on the system
// emoji font: Windows would render Segoe, Linux Noto, and a page icon would
// look like a different icon depending on who opened the page. Instead the
// Apple artwork is baked into one sprite sheet that we serve ourselves.
//
// The outputs are committed, so this script is not part of `npm run build` --
// re-run it by hand when emoji-datasource-apple is bumped:
//
//   npm install && node scripts/build-emoji-assets.mjs
//
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcImages = path.dirname(require.resolve('emoji-datasource-apple/package.json'));
const data = require('emoji-datasource-apple/emoji.json');

// Source art is 64px. We draw at half that: a page icon is never bigger than
// ~28px on screen, and 32px keeps the sheet inside a couple of hundred KB.
const GLYPH = 32;
// One transparent pixel around each glyph so a fractional background-size
// (any display size that is not exactly the cell size) cannot bleed a
// neighbour in at the edges.
const PAD = 1;
const CELL = GLYPH + PAD * 2;
const COLS = 44;

const OUT_SHEET = path.join(root, 'client/src/assets/emoji-sheet.webp');
const OUT_INDEX = path.join(root, 'client/src/lib/emojiIndex.json');

// Category order follows the ordering people expect from a picker;
// "Component" holds bare skin-tone swatches, which are not icons.
const CATEGORIES = [
  'Smileys & Emotion',
  'People & Body',
  'Animals & Nature',
  'Food & Drink',
  'Travel & Places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
];

// Skin-tone variants are deliberately dropped: they multiply the grid by six
// for icons that are shown at 16px, where the tone is not legible anyway.
const emoji = data
  .filter((e) => e.has_img_apple && CATEGORIES.includes(e.category))
  .sort(
    (a, b) =>
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.sort_order - b.sort_order,
  );

const rows = Math.ceil(emoji.length / COLS);
const width = COLS * CELL;
const height = rows * CELL;

// The stored icon is the emoji character itself, not a sheet coordinate, so
// existing icons keep working and markdown exports stay readable.
function toChar(unified) {
  return unified
    .split('-')
    .map((cp) => String.fromCodePoint(parseInt(cp, 16)))
    .join('');
}

const composites = [];
const index = [];

for (const [i, e] of emoji.entries()) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  composites.push({
    input: await sharp(path.join(srcImages, 'img/apple/64', e.image))
      .resize(GLYPH, GLYPH)
      .toBuffer(),
    left: col * CELL + PAD,
    top: row * CELL + PAD,
  });
  index.push({
    c: toChar(e.unified),
    n: e.name ? e.name.toLowerCase() : e.short_name,
    // Shortcodes plus the subcategory, so "heart" or "flag" finds the group
    // even when the Unicode name is an archaic one like "heavy black heart".
    k: [...new Set([...e.short_names, ...(e.subcategory || '').split('-')])].join(' '),
    g: CATEGORIES.indexOf(e.category),
    x: col,
    y: row,
  });
}

await mkdir(path.dirname(OUT_SHEET), { recursive: true });
await sharp({
  create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(composites)
  .webp({ quality: 80, alphaQuality: 90, effort: 6 })
  .toFile(OUT_SHEET);

await writeFile(
  OUT_INDEX,
  `${JSON.stringify({ cols: COLS, rows, categories: CATEGORIES, emoji: index })}\n`,
);

console.log(
  `sheet  ${width}x${height} (${COLS}x${rows} cells) -> ${path.relative(root, OUT_SHEET)}`,
);
console.log(`index  ${emoji.length} emoji -> ${path.relative(root, OUT_INDEX)}`);
