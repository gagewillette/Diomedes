async function request(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json response */
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
  window.addEventListener('pages-changed', handler);
  return () => window.removeEventListener('pages-changed', handler);
}
