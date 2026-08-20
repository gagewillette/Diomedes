// Apple emoji artwork, served from one sprite sheet so a page icon looks the
// same on macOS, Windows and Linux. See scripts/build-emoji-assets.mjs for how
// the sheet and index are produced.
import index from './emojiIndex.json';
import sheetUrl from '../assets/emoji-sheet.webp';
import { normalizeEmoji, rankEmoji } from './emojiSearch.js';

export const EMOJI = index.emoji;
export const EMOJI_CATEGORIES = index.categories;
export const EMOJI_SHEET_URL = sheetUrl;
export const EMOJI_COLS = index.cols;
export const EMOJI_ROWS = index.rows;

// Icons written before the sheet existed — or pasted in from elsewhere — may
// carry a variation selector the sheet keys without, so both spellings are
// indexed.
const byChar = new Map();
for (const e of EMOJI) {
  byChar.set(e.c, e);
  const bare = normalizeEmoji(e.c);
  if (bare !== e.c && !byChar.has(bare)) byChar.set(bare, e);
}

/** The sheet entry for an emoji character, or null if we have no artwork. */
export function lookupEmoji(char) {
  if (!char) return null;
  return byChar.get(char) || byChar.get(normalizeEmoji(char)) || null;
}

/**
 * Sprite positioning for one cell, sized so the element box is `size` px.
 * The glyph fills all but a one-pixel gutter, which is what keeps neighbours
 * from bleeding in at fractional scales.
 */
export function spriteStyle(entry, size) {
  return {
    backgroundImage: `url(${sheetUrl})`,
    backgroundSize: `${EMOJI_COLS * size}px ${EMOJI_ROWS * size}px`,
    backgroundPosition: `-${entry.x * size}px -${entry.y * size}px`,
    width: `${size}px`,
    height: `${size}px`,
  };
}

/** Emoji matching `query`, best first; everything when the query is empty. */
export function searchEmoji(query) {
  return rankEmoji(EMOJI, query);
}
