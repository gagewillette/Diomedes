// Everything the link dialog needs to know about a URL, kept out of React so it
// can be tested directly and shared with the click handler that opens links.

// The schemes a link is allowed to carry. Anything outside this list — most of
// all `javascript:` and `data:` — is a script-injection vector dressed up as a
// link, and a wiki anyone on the team can edit is exactly where that gets
// tried. Unknown schemes are rejected rather than passed through: a link the
// browser cannot open is no loss, one it opens unexpectedly might be.
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Control characters are how `java\nscript:` sneaks past a scheme check —
// browsers strip them before parsing, so we have to strip them before looking.
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

/**
 * What the user typed, turned into something a browser can open.
 *
 * A bare `example.com` becomes `https://example.com` — that is what everyone
 * means when they type it, and leaving it relative would silently point the
 * link back at this wiki. In-app paths (`/s/…`) and anchors are left exactly as
 * written. Returns '' when the input cannot safely become a link.
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(CONTROL_RE, '').trim();
  if (!cleaned) return '';

  if (cleaned.startsWith('/') || cleaned.startsWith('#')) return cleaned;

  if (SCHEME_RE.test(cleaned)) {
    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch {
      return '';
    }
    return ALLOWED_SCHEMES.has(parsed.protocol) ? cleaned : '';
  }

  // No scheme and not a path: treat it as a hostname. A space anywhere in it
  // means this was prose, not an address.
  if (/\s/.test(cleaned)) return '';
  const guess = `https://${cleaned}`;
  let parsed;
  try {
    parsed = new URL(guess);
  } catch {
    return '';
  }
  // `https://.` parses but has no host worth opening.
  return parsed.hostname ? guess : '';
}

/** True when `normalizeUrl` would give this input something openable. */
export const isValidUrl = (input) => normalizeUrl(input) !== '';

/** True for a link that leaves this wiki — the kind worth warning about. */
export function isExternalUrl(input) {
  const url = normalizeUrl(input);
  if (!url) return false;
  return !url.startsWith('/') && !url.startsWith('#');
}

/**
 * The part of a URL a person actually reads when deciding whether to trust it:
 * the host. Returns '' for in-app paths, which have no host to speak of.
 */
export function linkHost(input) {
  const url = normalizeUrl(input);
  if (!isExternalUrl(url)) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') return parsed.pathname || '';
  return parsed.hostname;
}
