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
export function enqueuePage(pageId, updatedAt, attempts = 0) {
  if (!client) return;
  const job = JSON.stringify({ pageId, updatedAt: new Date(updatedAt).toISOString(), attempts });
  client.lPush(QUEUE_KEY, job).catch((err) => console.error('embed enqueue failed', err.message));
  if (!attempts) {
    q(`UPDATE pages SET embedding_status = 'pending' WHERE id = $1`, [pageId]).catch(() => {});
  }
}

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

// Replace a page's chunks in one transaction, but only if the page has not been
// edited since we read it — otherwise a slow embedding call could overwrite the
// chunks of a newer revision with stale vectors.
async function writeChunks(pageId, updatedAt, chunks, vectors) {
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const { rows } = await conn.query('SELECT updated_at FROM pages WHERE id = $1 FOR UPDATE', [pageId]);
    if (!rows[0] || !sameInstant(rows[0].updated_at, updatedAt)) {
      await conn.query('ROLLBACK');
      return false;
    }
    await conn.query('DELETE FROM page_chunks WHERE page_id = $1', [pageId]);
    for (let i = 0; i < chunks.length; i++) {
      await conn.query(
        `INSERT INTO page_chunks (page_id, chunk_index, content, embedding, token_count)
         VALUES ($1, $2, $3, $4::vector, $5)`,
        [pageId, i, chunks[i].content, toVector(vectors[i]), chunks[i].tokenCount]
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
  const vectors = await embedBatch(chunks.map((c) => c.content));
  await writeChunks(page.id, page.updated_at, chunks, vectors);
}

async function handleFailure(job, err) {
  const attempts = (job.attempts || 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    console.error(`embedding job for ${job.pageId} failed (attempt ${attempts}):`, err.message);
    setTimeout(() => enqueuePage(job.pageId, job.updatedAt, attempts), RETRY_DELAY_MS).unref?.();
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
