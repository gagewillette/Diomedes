// The transfer router is mounted on /api as a whole, alongside the file and
// page routers. That makes *how* it attaches auth a load-bearing detail rather
// than a style choice, and the failure it causes is silent and remote: guests
// opening a public share link start getting 401s from a router that has nothing
// to do with sharing.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import transferRoutes from '../src/routes/transfer.js';

/** Start an app on an ephemeral port and return a fetch bound to it. */
async function serve(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    get: (path) => fetch(`http://127.0.0.1:${port}${path}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Mirrors index.js: the transfer router goes on /api, and unauthenticated
 * routes are mounted on /api after it. The stand-in below stands for
 * /api/public/:token, which guests reach with no session at all.
 */
function appWithPublicRouteAfterTransfer() {
  const app = express();
  app.use(express.json());
  app.use('/api', transferRoutes);
  app.get('/api/public/:token', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

test('an unauthenticated public route mounted after the transfer router still answers', async () => {
  // Regression: with router.use(requireAuth) inside the transfer router, this
  // request never reaches the handler below it — every guest on a share link
  // gets 401 instead of the page.
  const srv = await serve(appWithPublicRouteAfterTransfer());
  try {
    const res = await srv.get('/api/public/some-share-token');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await srv.close();
  }
});

test('the export-key routes still require a session', async () => {
  const srv = await serve(appWithPublicRouteAfterTransfer());
  try {
    const res = await srv.get('/api/spaces/11111111-2222-4333-8444-555555555555/export-keys');
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('redeeming a code needs no session, because the caller has no account here', async () => {
  const srv = await serve(appWithPublicRouteAfterTransfer());
  try {
    // No database in this test, so the interesting assertion is negative: it is
    // not turned away for lack of a session before the key is ever looked up.
    const res = await srv.get('/api/export/not-a-real-key');
    assert.notEqual(res.status, 401);
  } finally {
    await srv.close();
  }
});
