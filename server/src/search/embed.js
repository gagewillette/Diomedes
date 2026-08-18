import crypto from 'node:crypto';
import { recordEmbed } from './stats.js';

export const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
export const EMBED_DIMS = 1536;

const API_URL = 'https://api.openai.com/v1/embeddings';
const MAX_ATTEMPTS = 3;
const QUERY_CACHE_TTL = 300; // seconds — repeat searches are common and free here

let client = null;
export const initEmbed = (redis) => {
  client = redis;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class EmbedError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

// Embed a batch of texts. Retries throttling and transient upstream failures;
// a 4xx that will never succeed is thrown immediately so the caller can mark
// the job failed instead of spinning.
export async function embedBatch(texts, { maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!texts.length) return [];
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new EmbedError(`embedding API ${res.status}: ${body.slice(0, 200)}`, {
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      const data = await res.json();
      const vectors = data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      recordEmbed({ tokens: data.usage?.total_tokens || 0, ms: Date.now() - started, ok: true });
      return vectors;
    } catch (err) {
      const retryable = err instanceof EmbedError ? err.retryable : true; // network/timeout
      if (!retryable || attempt >= maxAttempts) {
        recordEmbed({ ok: false });
        throw err;
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

// pgvector accepts its text form: '[0.1,0.2,...]'
export const toVector = (embedding) => `[${embedding.join(',')}]`;

// Query embeddings are cached briefly — the same query text is re-searched
// constantly (typeahead, pagination) and each miss is a paid round trip.
export async function embedQuery(text) {
  const key = `diomedes:embed:q:${crypto.createHash('sha1').update(`${EMBED_MODEL}:${text}`).digest('hex')}`;
  if (client) {
    const hit = await client.get(key).catch(() => null);
    if (hit) return JSON.parse(hit);
  }
  // One attempt only: a search request must fall back to full-text fast rather
  // than hold the user on a retry backoff.
  const [embedding] = await embedBatch([text], { maxAttempts: 1 });
  if (client && embedding) client.setEx(key, QUERY_CACHE_TTL, JSON.stringify(embedding)).catch(() => {});
  return embedding;
}
