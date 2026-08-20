import { recordApiTiming, parseServerTiming, noteRequestStart, noteRequestEnd } from './perf.js';

async function request(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // Timed here rather than at each call site: this is the one place every API
  // request in the app passes through. The collector ignores it when logging
  // is off, so an untimed workspace pays only this clock read.
  const startedAt = performance.now();
  noteRequestStart();
  let res;
  let raw = '';
  let data = null;
  try {
    res = await fetch(url, init);
    try {
      raw = await res.text();
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-json response */
    }
    recordApiTiming({
      method,
      url,
      durationMs: performance.now() - startedAt,
      status: res.status,
      serverMs: parseServerTiming(res.headers.get('Server-Timing')),
      // The decompressed body; the exact wire size is only visible to the
      // resource observer, which rolls it into the 'fetch' bucket.
      bytes: raw.length,
    });
  } finally {
    // A network failure still ends the request as far as "is the app still
    // loading" is concerned, so this has to run on the throwing path too.
    noteRequestEnd();
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.noRedirect && !location.pathname.startsWith('/login')) {
      const from = location.pathname + location.search;
      if (!location.pathname.startsWith('/share/')) {
        location.assign(`/login?from=${encodeURIComponent(from)}`);
      }
    }
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body, opts),
  patch: (url, body, opts) => request('PATCH', url, body, opts),
  put: (url, body, opts) => request('PUT', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
};

// Tiny pub/sub so the sidebar tree refreshes when pages change elsewhere.
export function emitPagesChanged(spaceId) {
  window.dispatchEvent(new CustomEvent('pages-changed', { detail: { spaceId } }));
}
export function onPagesChanged(handler) {
  return onAppEvent('pages-changed', handler);
}

// Same channel, used by the realtime stream for workspace/permission changes:
// 'spaces-changed', 'space-members-changed', 'users-changed'.
export function onAppEvent(name, handler) {
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

// Wiki links live inside the editor, which also renders on public share pages
// outside the router. They ask for navigation through this channel instead of
// reaching for `useNavigate`, and whoever is inside the router answers.
export function emitNavigate(to) {
  window.dispatchEvent(new CustomEvent('gd-navigate', { detail: { to } }));
}
export function onNavigate(handler) {
  window.addEventListener('gd-navigate', handler);
  return () => window.removeEventListener('gd-navigate', handler);
}
