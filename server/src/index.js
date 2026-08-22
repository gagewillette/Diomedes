import express from 'express';
import http from 'node:http';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import { initSearch, searchHealth } from './search/index.js';
import { initEvents } from './lib/events.js';
import { initSessionLock } from './lib/sessionLock.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import spaceRoutes from './routes/spaces.js';
import pageRoutes from './routes/pages.js';
import fileRoutes, { STORAGE_PATH } from './routes/files.js';
import tokenRoutes from './routes/tokens.js';
import workspaceRoutes from './routes/workspace.js';
import { attachCollab } from './collab/index.js';
import eventRoutes from './routes/events.js';
import activeWindowRoutes from './routes/activeWindow.js';
import perfRoutes from './routes/perf.js';
import { perfMiddleware, initPerf, prune } from './lib/perf.js';
import { compressionMiddleware } from './lib/compress.js';
import { perfLoggingEnabled } from './lib/workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

async function main() {
  if (!process.env.APP_SECRET) throw new Error('APP_SECRET is required');
  fs.mkdirSync(path.join(STORAGE_PATH, 'tmp'), { recursive: true });
  await migrate();

  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  redis.on('error', (err) => console.error('redis error', err.message));
  await redis.connect();

  initSearch(redis);
  initEvents(redis);
  // Holds the "one active window per account" claim; same redis, short TTLs.
  initSessionLock(redis);
  // The recorder buffers in memory and flushes on a timer; it asks the
  // workspace switch at flush time, so turning logging off stops writes
  // without needing to tear the middleware out of the stack.
  initPerf(perfLoggingEnabled);
  // Aged-out samples go on boot and then daily — cheap, and it keeps a
  // long-running install from growing a table nobody ever looks at.
  const pruneSoon = () => prune().catch((err) => console.error('perf prune failed', err.message));
  pruneSoon();
  setInterval(pruneSoon, 24 * 3600 * 1000).unref();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '30mb' }));

  const sessionMiddleware = session({
    store: new RedisStore({ client: redis, prefix: 'diomedes:sess:' }),
    name: 'diomedes.sid',
    secret: process.env.APP_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: (process.env.APP_URL || '').startsWith('https') ? 'auto' : false,
      maxAge: 30 * 24 * 3600 * 1000,
    },
  });
  app.use(sessionMiddleware);
  // Before the routes so it wraps everything, after the session so a sample can
  // be attributed to a user once a route resolves one.
  app.use(perfMiddleware);

  // Outside perfMiddleware on purpose — see lib/compress.js.
  app.use(compressionMiddleware);

  app.get('/api/health', async (_req, res) => res.json({ ok: true, search: await searchHealth() }));
  app.use('/api/auth', authRoutes(redis));
  app.use('/api/users', userRoutes);
  app.use('/api/spaces', spaceRoutes);
  app.use('/api/tokens', tokenRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/active-window', activeWindowRoutes);
  app.use('/api/workspace', workspaceRoutes);
  app.use('/api/perf', perfRoutes);
  // fileRoutes first: it contains the unauthenticated /public and /files routes,
  // while pageRoutes guards its whole router with requireAuth.
  app.use('/api', fileRoutes);
  app.use('/api', pageRoutes);

  // Built client
  const publicDir = path.resolve(__dirname, '../public');
  app.use(express.static(publicDir, { maxAge: '1d', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });

  const server = http.createServer(app);
  await attachCollab(server, { redis, sessionMiddleware });
  server.listen(PORT, () => console.log(`diomedes listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
