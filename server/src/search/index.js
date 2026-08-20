import { vectorAvailable } from '../db.js';
import { initEmbed } from './embed.js';
import { EMBED_API_URL, EMBED_MODEL } from './config.js';
import { initStats, recordQuery, searchStats } from './stats.js';
import { startQueue, enqueuePage, queueDepth } from './queue.js';
import { ftsSearch } from './fts.js';
import { hybridSearch } from './hybrid.js';

// Semantic search is off unless it is switched on and given a provider — either
// an OpenAI key or a local OpenAI-compatible endpoint. Off means the pre-existing
// behaviour exactly: full-text only, no background work, no outbound calls.
export const semanticConfigured = () =>
  process.env.SEMANTIC_SEARCH_ENABLED === 'true' &&
  Boolean(process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_URL);

let active = false;
export const semanticActive = () => active;

export function initSearch(redis) {
  initStats(redis);
  if (!semanticConfigured()) {
    console.log(
      'search: full-text mode (set SEMANTIC_SEARCH_ENABLED=true plus OPENAI_API_KEY ' +
        'or EMBEDDING_API_URL for hybrid)'
    );
    return;
  }
  if (!vectorAvailable) {
    console.log('search: full-text mode — pgvector is not installed in this database');
    return;
  }
  initEmbed(redis);
  active = true;
  startQueue(redis).catch((err) => {
    active = false;
    console.error('search: embedding worker failed to start, falling back to full-text', err.message);
  });
  console.log(`search: hybrid mode (full-text + pgvector) via ${EMBED_MODEL} @ ${EMBED_API_URL}`);
}

// Single entry point for the /api/search route. Hybrid search degrades to
// full-text on any failure — a flaky embedding API must not break search.
export async function searchPages({ user, query, space, limit = 25 }) {
  const started = Date.now();
  let mode = 'fts';
  let results;
  if (active) {
    try {
      results = await hybridSearch({ user, query, space, limit });
      mode = 'hybrid';
    } catch (err) {
      console.error('hybrid search failed, falling back to full-text:', err.message);
    }
  }
  if (!results) results = await ftsSearch({ user, query, space, limit });
  recordQuery({ ms: Date.now() - started, mode });
  return results;
}

/**
 * Called from the page write path; never throws and never blocks the response.
 *
 * `blockIds` is the set of blocks that write actually changed, which is what
 * turns a re-embed of the whole page into a re-embed of one or two chunks. An
 * empty array means "nothing in the body changed" — a rename, say — and there
 * is no embedding work to do at all. Omitting the argument entirely means
 * "unknown", and the worker rebuilds the page from scratch as it always did.
 */
export function notePageChanged(pageId, updatedAt, blockIds) {
  if (!active || !pageId) return;
  if (Array.isArray(blockIds) && blockIds.length === 0) return;
  try {
    enqueuePage(pageId, updatedAt, blockIds ?? null);
  } catch (err) {
    console.error('failed to queue page for embedding', err.message);
  }
}

export async function searchHealth() {
  const mode = active ? 'hybrid' : 'fts';
  if (!active) return { mode, semanticConfigured: semanticConfigured(), vectorAvailable };
  return { mode, semanticConfigured: true, vectorAvailable, ...(await searchStats({ queueDepth: await queueDepth() })) };
}
