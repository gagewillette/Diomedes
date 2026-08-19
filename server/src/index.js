import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import { initSearch, searchHealth } from './search/index.js';
import { initEvents } from './lib/events.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import spaceRoutes from './routes/spaces.js';
import pageRoutes from './routes/pages.js';
import fileRoutes, { STORAGE_PATH } from './routes/files.js';
import tokenRoutes from './routes/tokens.js';
import eventRoutes from './routes/events.js';

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

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '30mb' }));

  app.use(
    session({
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
    })
  );

  app.get('/api/health', async (_req, res) => res.json({ ok: true, search: await searchHealth() }));
  app.use('/api/auth', authRoutes(redis));
  app.use('/api/users', userRoutes);
  app.use('/api/spaces', spaceRoutes);
  app.use('/api/tokens', tokenRoutes);
  app.use('/api/events', eventRoutes);
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

  app.listen(PORT, () => console.log(`diomedes listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
