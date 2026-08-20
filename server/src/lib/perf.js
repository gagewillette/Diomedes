// Performance logging: the store behind the workspace's timing panel.
//
// Two streams land in the same `perf_samples` table:
//
//   source='server'  — one row per finished HTTP request, written by the
//                      express middleware below. This is the only place that
//                      knows the *real* server time and the *real* number of
//                      bytes written to the socket.
//   source='client'  — batches posted by the browser: navigations, route
//                      transitions, interaction latency, web vitals, long
//                      tasks, and per-resource transfer totals.
//
// Rows are raw samples rather than pre-rolled counters, because the panel wants
// percentiles and you cannot average your way to a p95 after the fact. Volume
// is kept in check by a retention window and, on the client, a sample rate.
import { q } from '../db.js';

// §3.4 of the prospective-features doc asks for an *explicit* ceiling rather
// than a vague "should be fast". These are those numbers; the panel marks a
// metric red when its p95 crosses one, which is what makes a regression visible
// instead of merely recorded.
export const BUDGETS = {
  interaction: 100, // p95 input latency, ms
  route: 300, // p95 in-app page open, ms
  navigation: 1500, // p95 cold document load, ms
  api: 200, // p95 API round trip, ms
  server: 100, // p95 server handler time, ms
  lcp: 2500, // web vitals "good" thresholds
  inp: 200,
  fcp: 1800,
  ttfb: 800,
  cls: 0.1, // unitless
  longtask: 200,
};

// Sample kinds the ingest endpoint will accept from a browser. Anything else is
// dropped rather than stored: the table is written to by unprivileged users, so
// the vocabulary is closed.
export const CLIENT_KINDS = [
  'navigation', // full document load (cold open / reload)
  'route', // SPA route transition, click → rendered
  'interaction', // event latency (INP candidates)
  'longtask', // main-thread block > 50ms
  'api', // fetch to our own /api, measured in the browser
  'resource', // per-initiator-type transfer rollup
  'vital', // lcp / cls / fcp / ttfb / inp
];

export const RETENTION_DAYS = Number(process.env.PERF_RETENTION_DAYS || 14);
const MAX_BATCH = 200;
const FLUSH_MS = 10_000;
const MAX_BUFFER = 2_000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, max = 3_600_000) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, max) : 0;
const bytes = (v) => Math.round(num(v, 1024 ** 4));

/**
 * Coerce one browser-supplied sample into a storable row, or return null.
 *
 * Everything here is hostile input. Names are truncated rather than rejected so
 * one long URL does not throw away an otherwise valid batch, and durations are
 * clamped so a machine that slept mid-measurement cannot poison a percentile
 * with a six-hour "interaction".
 */
export function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (!CLIENT_KINDS.includes(kind)) return null;

  const name = typeof raw.name === 'string' ? raw.name.slice(0, 200) : '';
  // A vital without a name is meaningless — it is the name that says which
  // vital it is — and so is a resource rollup with nothing in it.
  if ((kind === 'vital' || kind === 'resource') && !name) return null;

  return {
    kind,
    name,
    // CLS arrives as a unitless score in the same column; it is small, so the
    // generic clamp leaves it alone.
    durationMs: num(raw.durationMs),
    serverMs: typeof raw.serverMs === 'number' && Number.isFinite(raw.serverMs) ? num(raw.serverMs) : null,
    transferBytes: bytes(raw.transferBytes),
    encodedBytes: bytes(raw.encodedBytes),
    decodedBytes: bytes(raw.decodedBytes),
    status: Number.isInteger(raw.status) && raw.status >= 100 && raw.status < 600 ? raw.status : null,
    count: Number.isInteger(raw.count) ? clamp(raw.count, 1, 100_000) : 1,
    detail: raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail) ? raw.detail : {},
  };
}

export function normalizeBatch(samples) {
  if (!Array.isArray(samples)) return [];
  return samples.slice(0, MAX_BATCH).map(normalizeSample).filter(Boolean);
}

/**
 * Compare a measured p95 against its budget. Returns null when there is no
 * budget for the metric, so the panel can render the number without a verdict
 * rather than inventing a passing grade.
 */
export function verdict(metric, value) {
  const budget = BUDGETS[metric];
  if (budget === undefined || value === null || value === undefined) return null;
  return { budget, value, ok: value <= budget };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Bulk-insert samples in a single statement. Called for both sources; the
 * server buffer flushes through here too.
 */
export async function insertSamples(source, rows, userId = null) {
  if (!rows.length) return 0;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * 12;
    values.push(
      `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12})`
    );
    params.push(
      r.ts ?? new Date(),
      source,
      r.kind,
      r.name,
      r.userId ?? userId,
      r.durationMs,
      r.serverMs,
      // The byte columns are bigint: a fractional value would be rejected by
      // postgres and take the whole batch down with it, so they are rounded
      // here rather than trusted from the caller.
      Math.round(r.transferBytes || 0),
      Math.round(r.encodedBytes || 0),
      Math.round(r.decodedBytes || 0),
      r.status,
      JSON.stringify(r.detail ?? {})
    );
  });
  await q(
    `INSERT INTO perf_samples
       (ts, source, kind, name, user_id, duration_ms, server_ms, transfer_bytes,
        encoded_bytes, decoded_bytes, status, detail)
     VALUES ${values.join(', ')}`,
    params
  );
  return rows.length;
}

export const prune = () =>
  q(`DELETE FROM perf_samples WHERE ts < now() - ($1 || ' days')::interval`, [RETENTION_DAYS]);

export const clearSamples = () => q('TRUNCATE perf_samples');

// ---------------------------------------------------------------------------
// The server-side request recorder
// ---------------------------------------------------------------------------

let buffer = [];
let timer = null;
let enabled = () => Promise.resolve(true);

/** Wire the middleware to the workspace switch. Called once at boot. */
export function initPerf(isEnabled) {
  enabled = isEnabled;
  if (timer) return;
  timer = setInterval(() => {
    flush().catch((err) => console.error('perf flush failed', err.message));
  }, FLUSH_MS);
  timer.unref?.();
}

export async function flush() {
  if (!buffer.length) return 0;
  // Take the buffer before awaiting so requests finishing during the insert
  // accumulate into the next batch instead of being dropped.
  const rows = buffer;
  buffer = [];
  if (!(await enabled())) return 0;
  await insertSamples('server', rows);
  return rows.length;
}

/**
 * Collapse a concrete URL into a route shape, so that a thousand page opens
 * aggregate into one row in the panel instead of a thousand distinct "names".
 * UUIDs and other long ids become `:id`.
 */
export function routeName(method, urlPath) {
  const path = (urlPath || '/').split('?')[0];
  const shaped = path
    .split('/')
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
      /^[A-Za-z0-9_-]{20,}$/.test(seg) ||
      /^\d+$/.test(seg)
        ? ':id'
        : seg
    )
    .join('/');
  return `${method} ${shaped}`.slice(0, 200);
}

// Never measured: the ingest endpoint (recording the recorder is a feedback
// loop) and the SSE stream (it is held open for minutes, so its "duration" is
// session length, not latency).
const SKIP = [/^\/api\/perf\//, /^\/api\/events/];

/**
 * Express middleware. Times every request, counts the bytes actually written to
 * the socket, and hands the browser a `Server-Timing` header so the client can
 * split its own round-trip measurement into server time vs. network time.
 */
export function perfMiddleware(req, res, next) {
  // Captured now, not in the finish handler: express rewrites req.url as the
  // request descends into a mounted router (`app.use('/api/auth', …)` leaves
  // req.path as '/me'), so reading it later would misfile every API call as a
  // static asset.
  const path = req.path;
  if (SKIP.some((re) => re.test(path))) return next();
  const started = process.hrtime.bigint();

  // Count real bytes rather than trusting Content-Length: streamed responses
  // and static file sends often have neither a length header nor a body we can
  // measure any other way.
  let written = 0;
  const { write, end } = res;
  const size = (chunk, encoding) => {
    if (!chunk) return 0;
    return Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  };
  res.write = function (chunk, encoding, cb) {
    written += size(chunk, encoding);
    return write.call(this, chunk, encoding, cb);
  };
  res.end = function (chunk, encoding, cb) {
    written += size(chunk, encoding);
    return end.call(this, chunk, encoding, cb);
  };

  // The header has to go out before the first byte of the body, so it is
  // stamped on the first write rather than at finish.
  const stamp = () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (!res.headersSent) {
      try {
        res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}`);
      } catch {
        /* headers already flushed by another writer */
      }
    }
    return ms;
  };
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const sent = written || Number(res.getHeader('content-length')) || 0;
    if (buffer.length < MAX_BUFFER) {
      buffer.push({
        kind: path.startsWith('/api/') ? 'api' : 'asset',
        name: routeName(req.method, path),
        userId: req.user?.id ?? null,
        durationMs,
        serverMs: durationMs,
        transferBytes: sent,
        encodedBytes: sent,
        decodedBytes: sent,
        status: res.statusCode,
        detail: {},
      });
    }
  });
  res.on('pipe', stamp);
  const origWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    stamp();
    return origWriteHead.apply(this, args);
  };
  next();
}
