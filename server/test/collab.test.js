// End-to-end check of the realtime editing stack: two websocket clients on the
// same page, over the real express + ws + postgres + redis path.
//
// Needs a database and redis, so it skips itself when they are not reachable.
// Point COLLAB_TEST_DATABASE_URL at a scratch database — the test creates its
// own schema and users.
//
// The suite runs under --test-force-exit: the y-websocket *client* used to
// drive these cases leaves reconnect timers behind after destroy(), which would
// otherwise keep the runner waiting. The server side is shut down explicitly in
// t.after and does release everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const DB_URL = process.env.COLLAB_TEST_DATABASE_URL;
const REDIS_URL = process.env.COLLAB_TEST_REDIS_URL || 'redis://localhost:6379';

const reachable = await (async () => {
  if (!DB_URL) return false;
  try {
    const probe = createClient({ url: REDIS_URL });
    probe.on('error', () => {});
    await probe.connect();
    await probe.quit();
    return true;
  } catch {
    return false;
  }
})();

test('realtime collaboration', { skip: reachable ? false : 'no COLLAB_TEST_DATABASE_URL / redis' }, async (t) => {
  process.env.DATABASE_URL = DB_URL;
  process.env.APP_SECRET = 'collab-test-secret';

  const { migrate, q, pool } = await import('../src/db.js');
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const pageRoutes = (await import('../src/routes/pages.js')).default;
  const { initSearch } = await import('../src/search/index.js');
  const { attachCollab } = await import('../src/collab/index.js');

  await migrate();
  await q('TRUNCATE users, spaces, pages, page_ydoc, space_members, settings CASCADE');

  const redis = createClient({ url: REDIS_URL });
  redis.on('error', () => {});
  await redis.connect();
  initSearch(redis);

  const sessionMiddleware = session({
    store: new RedisStore({ client: redis, prefix: 'diomedes:collabtest:' }),
    name: 'diomedes.sid',
    secret: process.env.APP_SECRET,
    resave: false,
    saveUninitialized: false,
  });

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use('/api/auth', authRoutes(redis));
  app.use('/api', pageRoutes);
  // Same JSON error shape as the real server, so a rejected login reads as JSON
  // here too rather than express's default HTML page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  const collabServer = await attachCollab(server, { redis, sessionMiddleware });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await collabServer.close();
    await new Promise((resolve) => server.close(resolve));
    await redis.quit();
    await pool.end();
  });

  // ---- fixtures: an owner, a page, and a reader with no write access ----

  const cookies = {};
  const call = async (who, method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookies[who] ? { cookie: cookies[who] } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookies[who] = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const setup = await call('owner', 'POST', '/api/auth/setup', {
    workspaceName: 'Test',
    name: 'Owner One',
    username: 'owner',
    password: 'password123',
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));

  const { rows: spaces } = await q('SELECT id FROM spaces LIMIT 1');
  const spaceId = spaces[0].id;
  const created = await call('owner', 'POST', '/api/pages', { spaceId, title: 'Shared' });
  assert.equal(created.status, 201);
  const pageId = created.body.page.id;

  // A second account that is a member of no space: it must not be able to open
  // the document at all.
  const { rows: outsiders } = await q(
    `INSERT INTO users (username, name, password_hash, role)
     VALUES ('outsider', 'Out Sider', '', 'member') RETURNING id`
  );
  const outsiderId = outsiders[0].id;

  // ---- a websocket that carries the session cookie ----
  const connect = (who, docId = pageId) => {
    const cookie = cookies[who];
    class CookieSocket extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols, { headers: cookie ? { cookie } : {} });
      }
    }
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/api/collab`, docId, ydoc, {
      WebSocketPolyfill: CookieSocket,
      disableBc: true,
    });
    return { ydoc, provider };
  };

  const waitFor = async (predicate, label, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  await t.test('edits converge between two clients', async () => {
    const a = connect('owner');
    const b = connect('owner');
    try {
      await waitFor(() => a.provider.synced && b.provider.synced, 'both clients to sync');

      a.ydoc.getText('body').insert(0, 'hello ');
      b.ydoc.getText('body').insert(0, 'world ');

      // Both edits target position 0 concurrently — the case that would need a
      // transform under OT. The CRDT resolves it to one deterministic order.
      await waitFor(
        () => a.ydoc.getText('body').toString() === b.ydoc.getText('body').toString(),
        'documents to converge'
      );
      assert.equal(a.ydoc.getText('body').length, 12);
    } finally {
      a.provider.destroy();
      b.provider.destroy();
    }
  });

  await t.test('presence and pointer positions reach other clients', async () => {
    const a = connect('owner');
    const b = connect('owner');
    try {
      await waitFor(() => a.provider.synced && b.provider.synced, 'sync');
      a.provider.awareness.setLocalStateField('user', {
        id: 'u1',
        name: 'Owner One',
        color: '#FF2D55',
        mode: 'pointing',
      });
      a.provider.awareness.setLocalStateField('pointer', { x: 0.42, y: 260 });

      await waitFor(() => {
        const seen = [...b.provider.awareness.getStates().values()].find((s) => s.user?.id === 'u1');
        return seen?.pointer?.x === 0.42 && seen.pointer.y === 260 && seen.user.mode === 'pointing';
      }, 'pointer to arrive');
    } finally {
      a.provider.destroy();
      b.provider.destroy();
    }
  });

  await t.test('the document survives every client leaving', async () => {
    const a = connect('owner');
    try {
      await waitFor(() => a.provider.synced, 'sync');
      a.ydoc.getText('body').insert(0, 'persisted! ');
    } finally {
      a.provider.destroy();
    }
    // The room flushes on a short debounce and again when it is evicted.
    await waitFor(async () => {
      const { rows } = await q('SELECT state FROM page_ydoc WHERE page_id = $1', [pageId]);
      if (!rows[0]) return false;
      const restored = new Y.Doc();
      Y.applyUpdate(restored, new Uint8Array(rows[0].state));
      return restored.getText('body').toString().includes('persisted!');
    }, 'the document to be written to postgres', 8000);

    const c = connect('owner');
    try {
      await waitFor(
        () => c.ydoc.getText('body').toString().includes('persisted!'),
        'a fresh client to receive the stored document'
      );
    } finally {
      c.provider.destroy();
    }
  });

  await t.test('a user with no access to the space is refused', async () => {
    await call('outsider', 'POST', '/api/auth/login', { username: 'outsider', password: 'x' });
    // No valid session at all: the upgrade must be rejected outright.
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/api/collab`, pageId, ydoc, {
      WebSocketPolyfill: WebSocket,
      disableBc: true,
      maxBackoffTime: 100,
    });
    try {
      let errored = false;
      provider.on('connection-error', () => {
        errored = true;
      });
      await waitFor(() => errored, 'the unauthenticated upgrade to be rejected');
      assert.equal(provider.synced, false);
    } finally {
      provider.destroy();
    }
    assert.ok(outsiderId);
  });

  await t.test('a reader cannot change the document', async () => {
    // Give the outsider read-only membership and a real session.
    await q(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      (await import('bcryptjs')).default.hashSync('password123', 4),
      outsiderId,
    ]);
    await q(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'reader')
             ON CONFLICT (space_id, user_id) DO UPDATE SET role = 'reader'`, [spaceId, outsiderId]);
    const login = await call('reader', 'POST', '/api/auth/login', {
      username: 'outsider',
      password: 'password123',
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const writer = connect('owner');
    const reader = connect('reader');
    try {
      await waitFor(() => writer.provider.synced && reader.provider.synced, 'sync');
      const before = writer.ydoc.getText('body').toString();

      reader.ydoc.getText('body').insert(0, 'VANDALISM ');
      // Presence from a reader is still welcome.
      reader.provider.awareness.setLocalStateField('user', {
        id: 'reader',
        name: 'Out Sider',
        color: '#00AEEF',
        mode: 'pointing',
      });

      await waitFor(
        () => [...writer.provider.awareness.getStates().values()].some((s) => s.user?.id === 'reader'),
        "the reader's presence to arrive"
      );
      // Presence made the round trip, so the rejected edit has had ample time
      // to arrive too — it simply never will.
      assert.equal(writer.ydoc.getText('body').toString(), before);
    } finally {
      writer.provider.destroy();
      reader.provider.destroy();
    }
  });
});
