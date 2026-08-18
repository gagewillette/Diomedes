import { vectorAvailable } from '../db.js';
import { initEmbed } from './embed.js';
import { initStats, recordQuery, searchStats } from './stats.js';
import { startQueue, enqueuePage, queueDepth } from './queue.js';
import { ftsSearch } from './fts.js';
import { hybridSearch } from './hybrid.js';

// Semantic search is off unless it is both switched on and given a key. Off
// means the pre-existing behaviour exactly: full-text only, no background work,
// no outbound API calls.
export const semanticConfigured = () =>
  process.env.SEMANTIC_SEARCH_ENABLED === 'true' && Boolean(process.env.OPENAI_API_KEY);

let active = false;
export const semanticActive = () => active;

export function initSearch(redis) {
  initStats(redis);
  if (!semanticConfigured()) {
    console.log('search: full-text mode (set SEMANTIC_SEARCH_ENABLED=true and OPENAI_API_KEY for hybrid)');
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
  console.log('search: hybrid mode (full-text + pgvector)');
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

// Called from the page write path; never throws and never blocks the response.
export function notePageChanged(pageId, updatedAt) {
  if (!active || !pageId) return;
  try {
    enqueuePage(pageId, updatedAt);
  } catch (err) {
    console.error('failed to queue page for embedding', err.message);
  }
}

export async function searchHealth() {
  const mode = active ? 'hybrid' : 'fts';
  if (!active) return { mode, semanticConfigured: semanticConfigured(), vectorAvailable };
  return { mode, semanticConfigured: true, vectorAvailable, ...(await searchStats({ queueDepth: await queueDepth() })) };
}
