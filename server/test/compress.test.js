import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import { compressionMiddleware } from '../src/lib/compress.js';
import { perfMiddleware } from '../src/lib/perf.js';

// A document-shaped body: prose-heavy JSON, well over the 1KB threshold.
const DOC = {
  content: {
    type: 'doc',
    content: Array.from({ length: 60 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `Paragraph ${i} of a page that reads like prose and repeats structure.` }],
    })),
  },
};

/** Boots an app on an ephemeral port and hands back a fetch-ish helper. */
async function serve(build) {
  const app = express();
  build(app);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, raw: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });

  return { get, close: () => new Promise((r) => server.close(r)) };
}

test('a document-sized JSON response is gzipped when the client accepts it', async () => {
  const app = await serve((a) => {
    a.use(compressionMiddleware);
    a.get('/doc', (_req, res) => res.json(DOC));
  });
  try {
    const plain = await app.get('/doc');
    const gzipped = await app.get('/doc', { 'Accept-Encoding': 'gzip' });

    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(gzipped.headers['content-encoding'], 'gzip');

    // Same bytes back out the other side.
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gzipped.raw).toString()), DOC);

    // And meaningfully smaller. This shape compresses far better than 2x, but
    // assert loosely so the test is about the wiring, not about zlib's tuning.
    assert.ok(
      gzipped.raw.length < plain.raw.length / 2,
      `expected gzip to at least halve ${plain.raw.length} bytes, got ${gzipped.raw.length}`
    );
  } finally {
    await app.close();
  }
});

test('responses under the threshold are left alone', async () => {
  const app = await serve((a) => {
    a.use(compressionMiddleware);
    a.get('/ok', (_req, res) => res.json({ ok: true }));
  });
  try {
    const res = await app.get('/ok', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(res.raw.toString()), { ok: true });
  } finally {
    await app.close();
  }
});

test('an SSE stream is never compressed', async () => {
  const app = await serve((a) => {
    a.use(compressionMiddleware);
    a.get('/events', (_req, res) => {
      // Mirrors lib/events.js addClient.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      // Push well past the compression threshold, then close.
      res.write(`data: ${'x'.repeat(4096)}\n\n`);
      res.end();
    });
  });
  try {
    const res = await app.get('/events', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.ok(res.raw.toString().startsWith('data: xxxx'));
  } finally {
    await app.close();
  }
});

test('perf counts the compressed bytes, not the bytes the route handed to res.json', async () => {
  // perfMiddleware measures by patching res.write/res.end, so it only sees what
  // actually reaches the socket if compression is registered *after* it —
  // res.write wrappers run outermost-last-registered-first, so compression has
  // to be the outer one to hand perf its already-compressed output.
  //
  // perf keeps its count in a module-level buffer that only flush() drains, so
  // this spies on it indirectly: a counter registered in the slot immediately
  // after perf is handed exactly what perf is handed, under either arrangement.
  // Move compression before perf and this drops back to the uncompressed size.
  let observed = 0;
  const spy = (_req, res, next) => {
    const { write, end } = res;
    const size = (c) => (c ? Buffer.byteLength(c) : 0);
    res.write = function (chunk, enc, cb) {
      observed += size(chunk);
      return write.call(this, chunk, enc, cb);
    };
    res.end = function (chunk, enc, cb) {
      observed += size(chunk);
      return end.call(this, chunk, enc, cb);
    };
    next();
  };
  const app = await serve((a) => {
    a.use(perfMiddleware);
    a.use(spy);
    a.use(compressionMiddleware);
    a.get('/doc', (_req, res) => res.json(DOC));
  });
  try {
    const gzipped = await app.get('/doc', { 'Accept-Encoding': 'gzip' });
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    assert.equal(
      observed,
      gzipped.raw.length,
      'byte counting sits inside compression — transfer_bytes would be reporting uncompressed sizes'
    );
  } finally {
    await app.close();
  }
});
