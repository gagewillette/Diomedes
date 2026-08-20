// Presence colours, derived from the user id.
//
// Deriving rather than assigning means every browser paints the same person the
// same colour without any coordination, and the colour survives reconnects,
// page switches and server restarts.
//
// The palette is deliberately narrow. A cursor has to be spotted instantly
// against both the light and dark editor background, so every entry is a
// saturated mid-luminance hue: nothing white, black, grey or dark, which also
// rules out anything that could be mistaken for text or the caret itself.
// server/test/userColor.test.js enforces those bounds.
export const PRESENCE_COLORS = [
  '#FF2D55', // rose red
  '#FF3B30', // red
  '#FF6B00', // orange
  '#FF9500', // amber
  '#FFC400', // gold
  '#A6E22E', // lime
  '#14D93F', // green
  '#00D68F', // emerald
  '#00C2C7', // teal
  '#00AEEF', // sky
  '#3B82F6', // blue
  '#7C5CFF', // violet
  '#B14DFF', // purple
  '#E040FB', // magenta
  '#FF4FD8', // hot pink
  '#FF5C8A', // pink
];

// FNV-1a. Cheap, and spreads the hex digits of a uuid evenly across the palette
// in a way that `charCodeAt(0)` style hashing does not.
export function hashString(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function pickUserColor(userId) {
  if (!userId) return PRESENCE_COLORS[0];
  return PRESENCE_COLORS[hashString(String(userId)) % PRESENCE_COLORS.length];
}

// WCAG relative luminance, used both by the tests and to decide whether a name
// label sits better with dark or light text.
export function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function saturation(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (l > 0.5 ? 2 - max - min : max + min);
}

// Text drawn *on* a presence colour: gold and lime need dark ink, blue and
// violet need light.
export const contrastInk = (hex) => (relativeLuminance(hex) > 0.45 ? '#141414' : '#FFFFFF');

// Same hue, translucent — for selection highlights, which sit behind live text.
export function withAlpha(hex, alpha) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
