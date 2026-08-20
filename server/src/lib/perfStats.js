// Reading side of performance logging: turns raw `perf_samples` rows into the
// numbers the Workspace info panel renders.
//
// Percentiles are computed in postgres (`percentile_cont`) rather than in node,
// so a month of samples never has to cross the wire to answer "what is the p95".
import { q } from '../db.js';
import { BUDGETS, RETENTION_DAYS, verdict } from './perf.js';

// Supported windows and the bucket width their timeline uses.
export const WINDOWS = {
  '1h': { interval: '1 hour', bucket: '1 minute' },
  '24h': { interval: '24 hours', bucket: '30 minutes' },
  '7d': { interval: '7 days', bucket: '3 hours' },
  '30d': { interval: '30 days', bucket: '12 hours' },
};

export const resolveWindow = (value) => (WINDOWS[value] ? value : '24h');

// The percentile expression reused by every query below.
//
// Rounded to three decimals rather than one: most of these are milliseconds,
// where one decimal would do, but CLS rides in the same column as a score
// around 0.05 — at one decimal every layout-shift figure collapses to 0.1.
// The display layer decides how many digits to actually show.
const PCTS = `
  count(*)::int                                          AS count,
  round(avg(duration_ms)::numeric, 3)::float8            AS avg,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric, 3)::float8 AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_ms)::numeric, 3)::float8 AS p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 3)::float8 AS p95,
  round(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::numeric, 3)::float8 AS p99,
  round(max(duration_ms)::numeric, 3)::float8            AS max`;

// Which stored (source, kind, name) maps onto which headline metric and budget.
// `vital` rows carry the vital's name, everything else is identified by kind.
const METRICS = [
  { metric: 'route', label: 'In-app page open', unit: 'ms', where: `source='client' AND kind='route'` },
  { metric: 'navigation', label: 'Cold document load', unit: 'ms', where: `source='client' AND kind='navigation'` },
  { metric: 'interaction', label: 'Interaction latency', unit: 'ms', where: `source='client' AND kind='interaction'` },
  { metric: 'api', label: 'API round trip (browser)', unit: 'ms', where: `source='client' AND kind='api'` },
  { metric: 'server', label: 'Server handler time', unit: 'ms', where: `source='server' AND kind='api'` },
  { metric: 'longtask', label: 'Main-thread long tasks', unit: 'ms', where: `source='client' AND kind='longtask'` },
  { metric: 'lcp', label: 'Largest contentful paint', unit: 'ms', where: `kind='vital' AND name='lcp'` },
  { metric: 'inp', label: 'Interaction to next paint', unit: 'ms', where: `kind='vital' AND name='inp'` },
  { metric: 'fcp', label: 'First contentful paint', unit: 'ms', where: `kind='vital' AND name='fcp'` },
  { metric: 'ttfb', label: 'Time to first byte', unit: 'ms', where: `kind='vital' AND name='ttfb'` },
  // CLS is a unitless score, not a duration, but it rides in the same column.
  { metric: 'cls', label: 'Cumulative layout shift', unit: 'score', where: `kind='vital' AND name='cls'` },
];

const empty = { count: 0, avg: null, p50: null, p75: null, p95: null, p99: null, max: null };

/** Headline metrics, each with its budget verdict attached. */
async function headline(interval) {
  const parts = METRICS.map(
    (m, i) => `SELECT ${i} AS ord, '${m.metric}'::text AS metric, ${PCTS}
               FROM perf_samples WHERE ts > now() - $1::interval AND ${m.where}`
  );
  const { rows } = await q(`${parts.join(' UNION ALL ')} ORDER BY ord`, [interval]);
  const byMetric = new Map(rows.map((r) => [r.metric, r]));
  return METRICS.map(({ metric, label, unit }) => {
    const row = byMetric.get(metric) || empty;
    return {
      metric,
      label,
      unit,
      count: row.count ?? 0,
      avg: row.avg,
      p50: row.p50,
      p75: row.p75,
      p95: row.p95,
      p99: row.p99,
      max: row.max,
      // No samples means no verdict — an empty workspace has not passed
      // anything, and showing it green would be a lie.
      budget: verdict(metric, row.count ? row.p95 : null),
    };
  });
}

/** The slowest API routes as the *server* timed them, with their byte volume. */
async function slowestRoutes(interval, limit = 15) {
  const { rows } = await q(
    `SELECT name, ${PCTS},
            sum(transfer_bytes)::bigint                      AS total_bytes,
            round(avg(transfer_bytes)::numeric, 0)::float8   AS avg_bytes,
            count(*) FILTER (WHERE status >= 400)::int       AS errors
     FROM perf_samples
     WHERE ts > now() - $1::interval AND source='server' AND kind='api'
     GROUP BY name
     HAVING count(*) > 0
     ORDER BY p95 DESC NULLS LAST
     LIMIT ${limit}`,
    [interval]
  );
  return rows.map((r) => ({
    name: r.name,
    count: r.count,
    p50: r.p50,
    p95: r.p95,
    p99: r.p99,
    max: r.max,
    errors: r.errors,
    totalBytes: Number(r.total_bytes || 0),
    avgBytes: Number(r.avg_bytes || 0),
  }));
}

/** Client-side route transitions, ranked by how slow they are to open. */
async function slowestScreens(interval, limit = 12) {
  const { rows } = await q(
    `SELECT name, ${PCTS}
     FROM perf_samples
     WHERE ts > now() - $1::interval AND source='client' AND kind IN ('route','navigation')
     GROUP BY name
     ORDER BY p95 DESC NULLS LAST
     LIMIT ${limit}`,
    [interval]
  );
  return rows;
}

/**
 * Data transfer. The server figure is authoritative (bytes actually written to
 * a socket); the client figure is what browsers report having received,
 * including everything served from cache, which is why the two differ.
 */
async function transfer(interval) {
  const [totals, byKind, byInitiator, top] = await Promise.all([
    q(
      `SELECT source,
              count(*)::int                AS requests,
              sum(transfer_bytes)::bigint  AS bytes,
              sum(decoded_bytes)::bigint   AS decoded
       FROM perf_samples WHERE ts > now() - $1::interval GROUP BY source`,
      [interval]
    ),
    q(
      `SELECT kind, count(*)::int AS requests, sum(transfer_bytes)::bigint AS bytes
       FROM perf_samples
       WHERE ts > now() - $1::interval AND source='server'
       GROUP BY kind ORDER BY bytes DESC NULLS LAST`,
      [interval]
    ),
    q(
      `SELECT name, sum(transfer_bytes)::bigint AS bytes,
              sum(decoded_bytes)::bigint        AS decoded,
              count(*)::int                     AS requests
       FROM perf_samples
       WHERE ts > now() - $1::interval AND source='client' AND kind='resource'
       GROUP BY name ORDER BY bytes DESC NULLS LAST LIMIT 12`,
      [interval]
    ),
    q(
      `SELECT name, sum(transfer_bytes)::bigint AS bytes, count(*)::int AS requests
       FROM perf_samples
       WHERE ts > now() - $1::interval AND source='server'
       GROUP BY name ORDER BY bytes DESC NULLS LAST LIMIT 12`,
      [interval]
    ),
  ]);
  const forSource = (s) => totals.rows.find((r) => r.source === s) || {};
  const server = forSource('server');
  const client = forSource('client');
  return {
    server: {
      requests: server.requests || 0,
      bytes: Number(server.bytes || 0),
    },
    client: {
      requests: client.requests || 0,
      bytes: Number(client.bytes || 0),
      decodedBytes: Number(client.decoded || 0),
    },
    byKind: byKind.rows.map((r) => ({ name: r.kind, requests: r.requests, bytes: Number(r.bytes || 0) })),
    byInitiator: byInitiator.rows.map((r) => ({
      name: r.name,
      requests: r.requests,
      bytes: Number(r.bytes || 0),
      decodedBytes: Number(r.decoded || 0),
    })),
    heaviestRoutes: top.rows.map((r) => ({ name: r.name, requests: r.requests, bytes: Number(r.bytes || 0) })),
  };
}

/** p95 latency and byte volume over time, for the sparkline/chart. */
async function timeline(interval, bucket) {
  const { rows } = await q(
    `SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS bucket,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms)
                  FILTER (WHERE s.source='server')::numeric, 3)::float8 AS server_p95,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms)
                  FILTER (WHERE s.source='client' AND s.kind IN ('route','navigation'))::numeric, 3)::float8 AS client_p95,
            count(s.id) FILTER (WHERE s.source='server')::int AS requests,
            coalesce(sum(s.transfer_bytes) FILTER (WHERE s.source='server'), 0)::bigint AS bytes
     FROM generate_series(
            date_bin($2::interval, now() - $1::interval, 'epoch'::timestamptz),
            date_bin($2::interval, now(), 'epoch'::timestamptz),
            $2::interval) AS b(bucket)
     LEFT JOIN perf_samples s
       ON date_bin($2::interval, s.ts, 'epoch'::timestamptz) = b.bucket
      AND s.ts > now() - $1::interval
     GROUP BY b.bucket ORDER BY b.bucket`,
    [interval, bucket]
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    serverP95: r.server_p95,
    clientP95: r.client_p95,
    requests: r.requests,
    bytes: Number(r.bytes || 0),
  }));
}

/** Status-code mix and error rate — a 500 that is fast is still a bad request. */
async function reliability(interval) {
  const { rows } = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status >= 400 AND status < 500)::int AS client_errors,
            count(*) FILTER (WHERE status >= 500)::int                  AS server_errors,
            count(DISTINCT user_id)::int                                AS users
     FROM perf_samples WHERE ts > now() - $1::interval AND source='server'`,
    [interval]
  );
  const r = rows[0] || {};
  const total = r.total || 0;
  return {
    requests: total,
    clientErrors: r.client_errors || 0,
    serverErrors: r.server_errors || 0,
    activeUsers: r.users || 0,
    errorRate: total ? Number((((r.client_errors + r.server_errors) / total) * 100).toFixed(2)) : 0,
  };
}

/** Everything the panel needs, for one window, in one round of queries. */
export async function perfOverview(windowKey) {
  const key = resolveWindow(windowKey);
  const { interval, bucket } = WINDOWS[key];
  const [metrics, routes, screens, bytes, series, health, coverage] = await Promise.all([
    headline(interval),
    slowestRoutes(interval),
    slowestScreens(interval),
    transfer(interval),
    timeline(interval, bucket),
    reliability(interval),
    q(
      `SELECT count(*)::int AS samples,
              min(ts) AS oldest,
              max(ts) AS newest
       FROM perf_samples`
    ),
  ]);
  const c = coverage.rows[0] || {};
  return {
    window: key,
    windows: Object.keys(WINDOWS),
    budgets: BUDGETS,
    retentionDays: RETENTION_DAYS,
    storedSamples: c.samples || 0,
    oldestSample: c.oldest,
    newestSample: c.newest,
    metrics,
    reliability: health,
    slowestRoutes: routes,
    slowestScreens: screens,
    transfer: bytes,
    timeline: series,
  };
}
