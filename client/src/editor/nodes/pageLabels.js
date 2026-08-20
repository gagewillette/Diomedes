// A `[[link]]` whose target did not exist when it was written carries a label
// and no id. Rather than rewriting the document once the target appears — a
// revision, a re-embed, and a race with whoever is editing — the chip resolves
// its label at render time, here. A link written before its target heals the
// moment the target exists, and write order stops deciding the link graph.
//
// Ids remain the durable truth for links that have one: this only ever runs for
// nodes with `pageId: null`, and never writes anything back to the document.
import { api, onPagesChanged, onAppEvent } from '../../lib/api.js';

// Must agree with the server's `normalizeTitle` (server/src/lib/links.js), so
// the cache key and the match are the same notion of "the same title".
export const normalizeLabel = (label) => (label || '').trim().replace(/\s+/g, ' ').toLowerCase();

const key = (spaceId, label) => `${spaceId || ''}::${normalizeLabel(label)}`;

const cache = new Map(); // key -> { id, title, icon, spaceSlug } | null when nothing matches
const subscribers = new Map(); // key -> Set<callback>
let pending = new Map(); // key -> { spaceId, label }
let scheduled = false;

// The endpoint takes at most 200 titles; a document with more unresolved links
// than that goes out as several requests rather than being silently truncated.
const BATCH_MAX = 200;

function notify(k) {
  for (const cb of subscribers.get(k) || []) cb(cache.get(k));
}

async function resolveBatch(spaceId, entries) {
  const titles = entries.map((e) => e.label);
  const { results } = await api.post(
    '/api/pages/resolve-titles',
    { spaceId: spaceId || undefined, titles },
    { noRedirect: true }
  );
  for (const entry of entries) {
    const found = results?.[entry.label];
    const k = key(spaceId, entry.label);
    // Ambiguous is deliberately a miss: two pages claim the title, and pointing
    // the chip at one of them would be a guess the reader can't see. It stays
    // unresolved, which is a state the chip already knows how to show.
    cache.set(
      k,
      found?.status === 'ok'
        ? { id: found.id, title: found.title, icon: found.icon, spaceSlug: found.space_slug }
        : null
    );
    notify(k);
  }
}

async function flush() {
  scheduled = false;
  const entries = [...pending.values()];
  pending = new Map();
  if (!entries.length) return;

  // One request per space, since resolution is space-relative.
  const bySpace = new Map();
  for (const entry of entries) {
    if (!bySpace.has(entry.spaceId)) bySpace.set(entry.spaceId, []);
    bySpace.get(entry.spaceId).push(entry);
  }
  for (const [spaceId, group] of bySpace) {
    for (let i = 0; i < group.length; i += BATCH_MAX) {
      try {
        await resolveBatch(spaceId, group.slice(i, i + BATCH_MAX));
      } catch {
        // Leave these uncached so a later render — or the next page change —
        // retries. A failed lookup must not look like "no such page".
      }
    }
  }
}

export function getCachedLabel(spaceId, label) {
  return cache.get(key(spaceId, label));
}

// Returns an unsubscribe function. Calls back immediately if already resolved.
export function subscribeLabel(spaceId, label, callback) {
  const norm = normalizeLabel(label);
  if (!norm) return () => {};
  const k = key(spaceId, label);
  if (!subscribers.has(k)) subscribers.set(k, new Set());
  subscribers.get(k).add(callback);

  if (cache.has(k)) {
    callback(cache.get(k));
  } else {
    // The normalized form goes on the wire: the server matches on it anyway,
    // and it keeps two spellings of one title from becoming two requests.
    pending.set(k, { spaceId, label: norm });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  }

  return () => {
    const set = subscribers.get(k);
    set?.delete(callback);
    if (set && !set.size) subscribers.delete(k);
  };
}

// Writing the page a gray link names is exactly the event that should turn it
// blue, so any page change re-asks for everything currently on screen.
export function clearLabelCache() {
  cache.clear();
  for (const k of subscribers.keys()) {
    const sep = k.indexOf('::');
    pending.set(k, { spaceId: k.slice(0, sep) || null, label: k.slice(sep + 2) });
  }
  if (pending.size && !scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

onPagesChanged(() => clearLabelCache());
onAppEvent('page-moved', () => clearLabelCache());
