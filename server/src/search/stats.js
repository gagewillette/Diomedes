import { q } from '../db.js';
// $ per 1M tokens for the configured model — used only for the rough spend
// estimate reported by /api/health. Zero when embedding runs locally.
import { USD_PER_MTOKEN } from './config.js';

const STATS_KEY = 'diomedes:search:stats';

let client = null;
export const initStats = (redis) => {
  client = redis;
};

const bump = (field, by = 1) => {
  if (client && by) client.hIncrBy(STATS_KEY, field, Math.round(by)).catch(() => {});
};

export function recordEmbed({ tokens = 0, ms = 0, ok = true }) {
  bump(ok ? 'embed_calls' : 'embed_errors');
  if (ok) {
    bump('embed_tokens', tokens);
    bump('embed_ms', ms);
  }
}

export function recordQuery({ ms = 0, mode = 'fts' }) {
  bump('query_calls');
  bump('query_ms', ms);
  bump(`query_${mode}`);
}

const avg = (total, count) => (count ? Math.round(total / count) : 0);

// Snapshot for /api/health: how much of the corpus is embedded, how deep the
// backlog is, and what the embedding API has cost so far.
export async function searchStats({ queueDepth = 0 } = {}) {
  const raw = client ? await client.hGetAll(STATS_KEY).catch(() => ({})) : {};
  const n = (field) => Number(raw[field] || 0);

  let coverage = null;
  try {
    const { rows } = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE embedding_status = 'ready')::int AS ready,
              count(*) FILTER (WHERE embedding_status = 'pending')::int AS pending,
              count(*) FILTER (WHERE embedding_status = 'failed')::int AS failed
       FROM pages WHERE deleted_at IS NULL`
    );
    const { rows: chunks } = await q('SELECT count(*)::int AS chunks FROM page_chunks');
    coverage = { ...rows[0], chunks: chunks[0].chunks };
  } catch {
    // page_chunks/embedding_status only exist once the vector migration ran
  }

  return {
    coverage,
    queueDepth,
    embeddings: {
      calls: n('embed_calls'),
      errors: n('embed_errors'),
      tokens: n('embed_tokens'),
      avgMs: avg(n('embed_ms'), n('embed_calls')),
      estimatedUsd: Number(((n('embed_tokens') / 1_000_000) * USD_PER_MTOKEN).toFixed(4)),
    },
    queries: {
      calls: n('query_calls'),
      avgMs: avg(n('query_ms'), n('query_calls')),
      hybrid: n('query_hybrid'),
      fts: n('query_fts'),
    },
  };
}
