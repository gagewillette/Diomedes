import { useEffect } from 'react';

// The browser tab is part of the UI: it should name whatever the window is
// showing and wear that thing's icon. Pages and spaces carry an emoji icon of
// their own; anything without one falls back to the app's own mark.

export const DEFAULT_TITLE = 'Diomedes';
export const DEFAULT_ICON = '📝';

// Titles come from user text, so they can be empty, whitespace, or long enough
// to be useless in a tab. Trim, fall back, and cut before the tab does.
const TITLE_MAX = 80;

export function formatTitle(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return DEFAULT_TITLE;
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

// Icons are stored as free text, so a page can hold a whole sentence where an
// emoji was expected. Anything that is not a short glyph run gets dropped
// rather than drawn illegibly small in a 16px favicon.
export function normalizeIcon(icon) {
  const trimmed = typeof icon === 'string' ? icon.trim() : '';
  if (!trimmed) return DEFAULT_ICON;
  // A few code points covers an emoji plus its variation selector, a keycap, or
  // a short ZWJ sequence; a surrogate pair counts as one. Beyond that, or with
  // plain letters in it, it is text rather than an icon.
  const points = Array.from(trimmed);
  if (points.length > 6 || /[A-Za-z0-9]/.test(trimmed)) return DEFAULT_ICON;
  return trimmed;
}

// An emoji favicon with no build step: draw the character into an SVG and hand
// it to the browser as a data URI. Percent-encoded whole, because a raw emoji
// in a URL is not portable across browsers.
export function faviconHref(icon) {
  const glyph = normalizeIcon(icon);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    + `<text y=".9em" font-size="90">${escapeXml(glyph)}</text>`
    + '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// The <link rel="icon"> in index.html is the one we keep rewriting; a document
// that somehow lost it gets a fresh one.
function iconLink() {
  if (typeof document === 'undefined') return null;
  let link = document.querySelector('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

export function applyDocumentIdentity(name, icon) {
  if (typeof document === 'undefined') return;
  document.title = formatTitle(name);
  const link = iconLink();
  const href = faviconHref(icon);
  // Rewriting an unchanged href makes some browsers re-fetch and flicker.
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/**
 * Name the tab after whatever this view is showing.
 *
 * Every routed view calls this; on unmount the tab returns to the app defaults
 * so a view that forgets to set them cannot inherit the previous one's name.
 */
export function useDocumentIdentity(name, icon) {
  useEffect(() => {
    applyDocumentIdentity(name, icon);
    return () => applyDocumentIdentity(DEFAULT_TITLE, DEFAULT_ICON);
  }, [name, icon]);
}
