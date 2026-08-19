// Queue every page that has no current embedding — run once after switching
// SEMANTIC_SEARCH_ENABLED on, so existing content becomes searchable:
//
//   docker compose exec diomedes npm run backfill:embeddings --prefix server
//
// The running server's worker does the actual embedding, so this exits quickly.
import { createClient } from 'redis';
import { pool, q } from '../db.js';
import { attachQueue, enqueuePage } from './queue.js';
import { semanticConfigured } from './index.js';

async function main() {
  if (!semanticConfigured()) {
    console.error(
      'SEMANTIC_SEARCH_ENABLED must be true, and either OPENAI_API_KEY or EMBEDDING_API_URL must be set'
    );
    process.exit(1);
  }
  const all = process.argv.includes('--all');
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  redis.on('error', (err) => console.error('redis error', err.message));
  await redis.connect();
  attachQueue(redis);

  const { rows } = await q(
    `SELECT id, updated_at FROM pages
     WHERE deleted_at IS NULL ${all ? '' : `AND embedding_status <> 'ready'`}
     ORDER BY updated_at DESC`
  );
  for (const page of rows) enqueuePage(page.id, page.updated_at);
  console.log(`queued ${rows.length} page(s) for embedding`);

  // lPush is fire-and-forget; let the writes drain before closing the socket.
  await redis.ping();
  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
