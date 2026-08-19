// A [[link]] stores the title it was written with, but its target may have been
// renamed since. Every link chip on screen asks here for the current title;
// requests made in the same tick are answered by one batched round trip, so a
// document with fifty links still costs a single request.
import { api, onPagesChanged } from '../../lib/api.js';

const cache = new Map(); // pageId -> { title, icon, spaceSlug } | null when gone
const subscribers = new Map(); // pageId -> Set<callback>
let pending = new Set();
let scheduled = false;

function notify(pageId) {
  for (const cb of subscribers.get(pageId) || []) cb(cache.get(pageId));
}

async function flush() {
  scheduled = false;
  const ids = [...pending];
  pending = new Set();
  if (!ids.length) return;
  try {
    const data = await api.get(`/api/pages/titles?ids=${ids.join(',')}`, { noRedirect: true });
    const found = new Map(data.pages.map((p) => [p.id, p]));
    for (const id of ids) {
      const page = found.get(id);
      // A miss means deleted or no longer readable — remembered as null so the
      // chip can show itself as broken instead of asking again on every render.
      cache.set(id, page ? { title: page.title, icon: page.icon, spaceSlug: page.space_slug } : null);
      notify(id);
    }
  } catch {
    // Leave the ids uncached so a later render can retry.
  }
}

export function getCachedTitle(pageId) {
  return cache.get(pageId);
}

// Returns an unsubscribe function. Calls back immediately if already cached.
export function subscribeTitle(pageId, callback) {
  if (!pageId) return () => {};
  if (!subscribers.has(pageId)) subscribers.set(pageId, new Set());
  subscribers.get(pageId).add(callback);

  if (cache.has(pageId)) {
    callback(cache.get(pageId));
  } else {
    pending.add(pageId);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  }

  return () => {
    const set = subscribers.get(pageId);
    set?.delete(callback);
    if (set && !set.size) subscribers.delete(pageId);
  };
}

// Titles go stale when pages are renamed elsewhere; drop everything and
// re-resolve whatever is still on screen.
export function clearTitleCache() {
  cache.clear();
  for (const pageId of subscribers.keys()) pending.add(pageId);
  if (pending.size && !scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

// Renaming a page anywhere in the app invalidates every chip pointing at it.
onPagesChanged(() => clearTitleCache());
