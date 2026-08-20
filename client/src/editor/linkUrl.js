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

// Hosts that deliberately hide where a link goes. Not malicious in themselves,
// but a reader cannot judge the destination from the text, which is exactly the
// judgement the hover card exists to support.
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'is.gd',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'lnkd.in', 't.ly',
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * How much a reader should trust this address, as a traffic light.
 *
 * `unsafe` is reserved for things that are actively deceptive or that a browser
 * should never be handed: a scheme we refuse, a host disguised with embedded
 * credentials (`https://docs.google.com@evil.example`, which reads as Google
 * and goes to evil.example), or a punycode host that can spell a familiar name
 * in another alphabet.
 *
 * `caution` is for links that are fine but worth a second look — unencrypted
 * http, a bare IP address, an odd port, or a shortener that hides its
 * destination.
 *
 * Everything else is `safe`, which here means "nothing about the address itself
 * is suspicious" — not that the site is trustworthy. That judgement stays with
 * the reader, which is why the card shows the host rather than just a verdict.
 */
export function linkSafety(input) {
  const url = normalizeUrl(input);
  if (!url) return { level: 'unsafe', label: 'Blocked', reason: 'This address cannot be opened safely.' };

  if (!isExternalUrl(url)) {
    return { level: 'safe', label: 'This wiki', reason: 'Stays inside this workspace.' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { level: 'unsafe', label: 'Blocked', reason: 'This address cannot be opened safely.' };
  }

  if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') {
    return { level: 'safe', label: 'Contact', reason: 'Opens your mail or phone app.' };
  }

  // `new URL` puts anything before the `@` into username/password. That is the
  // oldest trick for making a link read as one site and go to another.
  if (parsed.username || parsed.password) {
    return {
      level: 'unsafe',
      label: 'Deceptive',
      reason: `Text before the @ hides the real destination, which is ${parsed.hostname}.`,
    };
  }

  const host = parsed.hostname.toLowerCase();

  if (host.startsWith('xn--') || host.includes('.xn--')) {
    return {
      level: 'unsafe',
      label: 'Lookalike',
      reason: 'This host uses non-Latin characters that can imitate a familiar name.',
    };
  }

  if (SHORTENERS.has(host)) {
    return {
      level: 'caution',
      label: 'Shortened',
      reason: 'A shortener hides where this actually goes until you open it.',
    };
  }

  if (IPV4_RE.test(host)) {
    return { level: 'caution', label: 'IP address', reason: 'Goes to a raw address with no site name.' };
  }

  if (parsed.protocol === 'http:') {
    return { level: 'caution', label: 'Not encrypted', reason: 'http:// traffic can be read in transit.' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { level: 'caution', label: `Port ${parsed.port}`, reason: 'Uses an unusual port for the web.' };
  }

  return { level: 'safe', label: 'Looks fine', reason: 'Encrypted, and the address matches the site it names.' };
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
