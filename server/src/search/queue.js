import { q, pool } from '../db.js';
import { chunkPage } from './chunk.js';
import { embedBatch, toVector } from './embed.js';

const QUEUE_KEY = 'diomedes:embed:queue';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

let client = null; // command connection
let worker = null; // duplicate used for the blocking pop
let running = false;

export async function queueDepth() {
  if (!client) return 0;
  return client.lLen(QUEUE_KEY).catch(() => 0);
}

// Enqueue a page for (re)embedding. Fire-and-forget by design: request handlers
// call this on the write path and must never fail because redis hiccuped.
export function enqueuePage(pageId, updatedAt, blockIds = null, attempts = 0) {
  if (!client) return;
  // `blockIds` is what makes the job incremental: the set of blocks the write
  // actually changed. Null means "no idea" — a backfill, a restore, anything
  // that did not go through the block projection — and the worker falls back
  // to rebuilding the whole page.
  const job = JSON.stringify({
    pageId,
    updatedAt: new Date(updatedAt).toISOString(),
    blockIds: blockIds?.length ? blockIds : null,
    attempts,
  });
  client.lPush(QUEUE_KEY, job).catch((err) => console.error('embed enqueue failed', err.message));
  if (!attempts) {
    q(`UPDATE pages SET embedding_status = 'pending' WHERE id = $1`, [pageId]).catch(() => {});
  }
}

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

// Replace a page's chunks in one transaction, but only if the page has not been
// edited since we read it — otherwise a slow embedding call could overwrite the
// chunks of a newer revision with stale vectors.
async function writeChunks(pageId, updatedAt, chunks, vectors, reused) {
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const { rows } = await conn.query('SELECT updated_at FROM pages WHERE id = $1 FOR UPDATE', [pageId]);
    if (!rows[0] || !sameInstant(rows[0].updated_at, updatedAt)) {
      await conn.query('ROLLBACK');
      return false;
    }
    // Chunk indices are positional, so a page whose chunk count changed cannot
    // have rows updated in place — the whole set is replaced, and the vectors
    // that did not need recomputing are carried across rather than re-embedded.
    await conn.query('DELETE FROM page_chunks WHERE page_id = $1', [pageId]);
    for (let i = 0; i < chunks.length; i++) {
      // A freshly computed embedding is an array of numbers; a reused one came
      // straight back out of postgres and is already in the wire format.
      const vector = vectors[i] ?? reused?.get(chunks[i].content) ?? null;
      const literal = Array.isArray(vector) ? toVector(vector) : vector;
      await conn.query(
        `INSERT INTO page_chunks (page_id, chunk_index, content, embedding, token_count, source_block_ids)
         VALUES ($1, $2, $3, $4::vector, $5, $6::text[])`,
        [pageId, i, chunks[i].content, literal, chunks[i].tokenCount, chunks[i].blockIds || []]
      );
    }
    await conn.query(`UPDATE pages SET embedding_status = 'ready' WHERE id = $1`, [pageId]);
    await conn.query('COMMIT');
    return true;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Which of the freshly computed chunks actually need an embedding call.
 *
 * This is the whole point of the migration for search. Today every save
 * re-chunks the page, deletes all of its chunks and re-embeds every one from
 * scratch: fix a typo in a forty-chunk page and that is forty embedding calls.
 * There was no way to do better, because `page_chunks` is keyed by
 * `chunk_index`, which shifts whenever anything above it changes — nothing
 * stable to diff against.
 *
 * With block ids there is. A chunk records the blocks it was built from, so a
 * chunk needs re-embedding only if it is genuinely new text, or if it draws on
 * a block this save changed.
 *
 * Reuse is keyed on the chunk's exact content rather than its index, which is
 * what makes it safe when the chunk count changes: inserting a paragraph at the
 * top shifts every index by one, but the text of the chunks below is
 * byte-identical and their vectors are still correct. The overlap carry is
 * handled by the same rule for free — a chunk that borrowed a tail from an
 * edited block has different content, so it is recomputed rather than being
 * left subtly stale.
 */
export function chunksNeedingEmbedding(chunks, previous, changedBlockIds) {
  if (!changedBlockIds) return { stale: chunks.map((_, i) => i), reused: new Map() };
  const changed = new Set(changedBlockIds);
  // A row whose embedding never landed (a previous run that failed partway)
  // is not reusable, so it is not offered as a candidate.
  const byContent = new Map(previous.filter((row) => row.embedding).map((row) => [row.content, row.embedding]));
  const stale = [];
  const reused = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const known = byContent.get(chunk.content);
    const touchesChanged = (chunk.blockIds || []).some((id) => changed.has(id));
    if (!known || touchesChanged) stale.push(i);
    else reused.set(chunk.content, known);
  }
  return { stale, reused };
}

async function processJob(job) {
  const { rows } = await q(
    'SELECT id, title, content, updated_at, deleted_at FROM pages WHERE id = $1',
    [job.pageId]
  );
  const page = rows[0];
  if (!page || page.deleted_at) return;
  // A newer edit already queued its own job; let that one do the work.
  if (!sameInstant(page.updated_at, job.updatedAt)) return;

  await q(`UPDATE pages SET embedding_status = 'processing' WHERE id = $1`, [page.id]);
  const chunks = chunkPage({ title: page.title, content: page.content });
  if (!chunks.length) {
    await q('DELETE FROM page_chunks WHERE page_id = $1', [page.id]);
    await q(`UPDATE pages SET embedding_status = 'ready' WHERE id = $1`, [page.id]);
    return;
  }

  // A title change rewrites the prefix of every chunk on the page, so nothing
  // can be reused — the stored text genuinely differs. That falls out of
  // content-keyed reuse without needing to be detected.
  const { rows: previous } = job.blockIds
    ? await q('SELECT content, embedding FROM page_chunks WHERE page_id = $1', [page.id])
    : { rows: [] };
  const { stale, reused } = chunksNeedingEmbedding(chunks, previous, job.blockIds);

  const vectors = new Array(chunks.length).fill(null);
  if (stale.length) {
    const fresh = await embedBatch(stale.map((i) => chunks[i].content));
    stale.forEach((i, n) => {
      vectors[i] = fresh[n];
    });
  }
  await writeChunks(page.id, page.updated_at, chunks, vectors, reused);
}

async function handleFailure(job, err) {
  const attempts = (job.attempts || 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    console.error(`embedding job for ${job.pageId} failed (attempt ${attempts}):`, err.message);
    setTimeout(() => enqueuePage(job.pageId, job.updatedAt, job.blockIds, attempts), RETRY_DELAY_MS).unref?.();
    return;
  }
  console.error(`embedding job for ${job.pageId} gave up after ${attempts} attempts:`, err.message);
  await q(`UPDATE pages SET embedding_status = 'failed' WHERE id = $1`, [job.pageId]).catch(() => {});
}

async function loop() {
  while (running) {
    let job;
    try {
      const popped = await worker.brPop(QUEUE_KEY, 5);
      if (!popped) continue;
      job = JSON.parse(popped.element);
    } catch (err) {
      if (!running) return;
      console.error('embedding queue read failed', err.message);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    try {
      await processJob(job);
    } catch (err) {
      await handleFailure(job, err);
    }
  }
}

// Enough to enqueue jobs; the backfill script needs this without a worker.
export const attachQueue = (redis) => {
  client = redis;
};

export async function startQueue(redis) {
  attachQueue(redis);
  worker = redis.duplicate();
  worker.on('error', (err) => console.error('embedding worker redis error', err.message));
  await worker.connect();
  running = true;
  loop();
}

export async function stopQueue() {
  running = false;
  if (worker) await worker.quit().catch(() => {});
  worker = null;
}
