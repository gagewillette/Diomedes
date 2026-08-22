// Client half of "one active window per account".
//
// The id lives in sessionStorage, which is scoped to a tab: a new window (or a
// new tab) starts without one and mints its own, while a reload keeps the same
// id and so keeps the claim it already holds. Duplicating a tab copies
// sessionStorage, so the copy counts as the same window — that is the one case
// where two views share a claim, and it is not worth breaking reloads over.
import { api } from './api.js';

const STORAGE_KEY = 'diomedes.windowId';

const mintId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64url, so it matches the server's [A-Za-z0-9_-]{8,64} check.
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let cached = null;

export function windowId() {
  if (cached) return cached;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return cached;
    }
    cached = mintId();
    sessionStorage.setItem(STORAGE_KEY, cached);
  } catch {
    // Private-mode storage errors: fall back to a per-load id. The window still
    // works, it just loses its claim across a reload.
    cached = cached || mintId();
  }
  return cached;
}

// Rendered in the other window's takeover prompt, so it stays short and plain.
export function windowLabel() {
  const ua = navigator.userAgent || '';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'a browser';
  const os =
    /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /(iPhone|iPad)/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  return os ? `${browser} on ${os}` : browser;
}

const body = (extra) => ({ clientId: windowId(), label: windowLabel(), ...extra });

// `force: true` is the Switch button — take the account over from whichever
// window holds it now.
export const claimWindow = ({ force = false } = {}) =>
  api.post('/api/active-window/claim', body({ force }), { noRedirect: true });

export const heartbeatWindow = () =>
  api.post('/api/active-window/heartbeat', body(), { noRedirect: true });

// Called on unload, where a normal fetch is not guaranteed to finish. The
// explicit JSON blob keeps express.json parsing it; a failed beacon is fine,
// the claim just falls out on its TTL instead.
export function releaseWindow() {
  const payload = JSON.stringify({ clientId: windowId() });
  try {
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon(
        '/api/active-window/release',
        new Blob([payload], { type: 'application/json' })
      );
      if (ok) return;
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    fetch('/api/active-window/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* nothing more we can do from an unloading page */
  }
}
