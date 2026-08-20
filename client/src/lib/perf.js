// Client-side performance logging.
//
// Everything the browser can tell us about how this app feels — cold load, SPA
// route transitions, input latency, web vitals, main-thread long tasks and the
// bytes pulled over the wire — is buffered here and posted in batches to
// /api/perf/samples, where the workspace panel reads it back.
//
// Three rules shape the design:
//
//   1. Measuring must never be the slow thing. Everything runs off
//      PerformanceObserver (which the browser fills in for free), the buffer is
//      capped, and posts are batched on a timer rather than per event.
//   2. The switch is authoritative. When an admin turns logging off the
//      collector stops, and the server drops anything already in flight.
//   3. Missing APIs are not errors. Safari has no `longtask`, older browsers
//      have no `event` timing; each observer is attached independently and a
//      failure to attach costs nothing.

const ENDPOINT = '/api/perf/samples';
const FLUSH_MS = 15_000;
const MAX_BUFFER = 150;
// Below this an "interaction" is indistinguishable from the frame it landed in,
// and recording it would bury the slow ones under a mountain of 8ms rows.
const INTERACTION_MIN_MS = 40;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Collapse a concrete pathname into the screen it represents, so that opening
 * five hundred different pages aggregates into one "/s/:slug/p/:id" row rather
 * than five hundred rows of one sample each.
 */
export function screenName(pathname) {
  const segs = (pathname || '/').split('?')[0].split('/').filter(Boolean);
  if (!segs.length) return '/';
  const shaped = segs.map((seg, i) => {
    // The first segment is always a literal route prefix ('s', 'settings',
    // 'share'); it is what makes the name readable, so it is never masked.
    if (i === 0) return seg;
    const prev = segs[i - 1];
    if (prev === 's') return ':slug';
    if (prev === 'p' || prev === 'share') return ':id';
    return /^[0-9a-f-]{16,}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg;
  });
  return `/${shaped.join('/')}`;
}

/** Same idea for the API surface: strip ids so routes aggregate. */
export function apiName(method, url) {
  const path = String(url || '').split('?')[0];
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
  return `${method} ${shaped}`;
}

/**
 * Pull the server's own timing out of a `Server-Timing` response header.
 * Returns null when the header is absent, which is how a sample says "this
 * round trip was never split into server and network".
 */
export function parseServerTiming(header) {
  if (!header) return null;
  const match = /(?:^|,)\s*app;dur=([0-9.]+)/i.exec(header);
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether this sample is kept, given a sample rate. Vitals and
 * navigations bypass the rate: there are only a handful per page load, and
 * throwing them away leaves the panel with nothing to show.
 */
export function shouldSample(kind, rate, roll = Math.random()) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  if (kind === 'vital' || kind === 'navigation' || kind === 'route') return true;
  return roll < rate;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

const state = {
  enabled: false,
  sampleRate: 1,
  buffer: [],
  observers: [],
  timer: null,
  // Route transition currently being timed: { name, startedAt, settled }.
  route: null,
  // Per-initiator-type transfer totals, flushed as rollups.
  resources: new Map(),
  // Largest interaction seen this page-load; reported as the INP estimate.
  worstInteraction: 0,
  cls: 0,
  reportedVitals: new Set(),
};

function push(sample) {
  if (!state.enabled) return;
  if (!shouldSample(sample.kind, state.sampleRate)) return;
  if (state.buffer.length >= MAX_BUFFER) return; // drop rather than grow unbounded
  state.buffer.push(sample);
  if (state.buffer.length >= MAX_BUFFER / 2) flush();
}

/** Fold the pending resource rollups into the buffer as one sample each. */
function drainResources() {
  for (const [name, r] of state.resources) {
    state.buffer.push({
      kind: 'resource',
      name,
      durationMs: r.durationMs,
      transferBytes: r.transferBytes,
      encodedBytes: r.encodedBytes,
      decodedBytes: r.decodedBytes,
      count: r.count,
    });
  }
  state.resources.clear();
}

export function flush({ beacon = false } = {}) {
  if (!state.enabled) return;
  drainResources();
  if (!state.buffer.length) return;
  const samples = state.buffer;
  state.buffer = [];
  const body = JSON.stringify({ samples });

  // On the way out the page there is no time for a fetch to complete; a beacon
  // survives the unload where a normal request would be cancelled.
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    return;
  }
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  })
    .then((res) => res.json())
    .then((data) => {
      // The server is the authority: if an admin turned logging off while this
      // batch was in flight, stop collecting now instead of waiting for the
      // settings event to arrive.
      if (data && data.enabled === false) stopPerfCollector();
      else if (data && typeof data.sampleRate === 'number') state.sampleRate = data.sampleRate;
    })
    .catch(() => {
      /* telemetry must never surface an error to the user */
    });
}

function observe(type, handler, options = {}) {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => handler(list.getEntries()));
    obs.observe({ type, buffered: true, ...options });
    state.observers.push(obs);
  } catch {
    // This entry type is not supported here. Every observer is independent, so
    // the rest of the collector carries on.
  }
}

const vital = (name, durationMs) => {
  push({ kind: 'vital', name, durationMs });
};

function attachObservers() {
  // Cold document load, plus the TTFB vital that comes out of the same entry.
  observe('navigation', (entries) => {
    for (const e of entries) {
      push({
        kind: 'navigation',
        name: screenName(location.pathname),
        durationMs: e.duration || e.loadEventEnd || 0,
        serverMs: e.responseStart && e.requestStart ? e.responseStart - e.requestStart : null,
        transferBytes: e.transferSize || 0,
        encodedBytes: e.encodedBodySize || 0,
        decodedBytes: e.decodedBodySize || 0,
        detail: {
          dns: Math.round(e.domainLookupEnd - e.domainLookupStart),
          tcp: Math.round(e.connectEnd - e.connectStart),
          domInteractive: Math.round(e.domInteractive),
          domComplete: Math.round(e.domComplete),
          type: e.type,
        },
      });
      vital('ttfb', Math.max(0, e.responseStart));
    }
  });

  observe('paint', (entries) => {
    for (const e of entries) {
      if (e.name === 'first-contentful-paint' && !state.reportedVitals.has('fcp')) {
        state.reportedVitals.add('fcp');
        vital('fcp', e.startTime);
      }
    }
  });

  // LCP keeps being revised upward until the user interacts; the last value
  // observed before the page is hidden is the one that counts, so it is
  // recorded at flush-on-hide rather than here.
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) state.lcp = last.startTime;
  });

  observe('layout-shift', (entries) => {
    for (const e of entries) if (!e.hadRecentInput) state.cls += e.value;
  });

  // Input latency. Each slow interaction is stored so the server can compute a
  // true p95; the worst one doubles as this page's INP estimate.
  observe(
    'event',
    (entries) => {
      for (const e of entries) {
        const d = e.duration || 0;
        if (d < INTERACTION_MIN_MS) continue;
        state.worstInteraction = Math.max(state.worstInteraction, d);
        push({ kind: 'interaction', name: e.name || 'event', durationMs: d });
      }
    },
    { durationThreshold: INTERACTION_MIN_MS }
  );

  observe('longtask', (entries) => {
    for (const e of entries) {
      push({ kind: 'longtask', name: e.attribution?.[0]?.name || 'unknown', durationMs: e.duration });
    }
  });

  // Data transfer. Rolled up by initiator type rather than stored per URL: the
  // interesting question is "how many bytes of script/image/fetch", and a row
  // per asset would swamp the table.
  observe('resource', (entries) => {
    for (const e of entries) {
      if (e.name.includes('/api/perf/')) continue; // never measure the measurer
      const key = e.initiatorType || 'other';
      const r = state.resources.get(key) || {
        durationMs: 0,
        transferBytes: 0,
        encodedBytes: 0,
        decodedBytes: 0,
        count: 0,
      };
      r.durationMs = Math.max(r.durationMs, e.duration || 0);
      r.transferBytes += e.transferSize || 0;
      r.encodedBytes += e.encodedBodySize || 0;
      r.decodedBytes += e.decodedBodySize || 0;
      r.count += 1;
      state.resources.set(key, r);
    }
  });
}

/** Report the vitals that are only final once the page is going away. */
function reportFinalVitals() {
  if (state.lcp && !state.reportedVitals.has('lcp')) {
    state.reportedVitals.add('lcp');
    vital('lcp', state.lcp);
  }
  if (state.worstInteraction) vital('inp', state.worstInteraction);
  // CLS is a score, not a duration; it rides in the same numeric column.
  if (state.cls) vital('cls', state.cls);
  state.worstInteraction = 0;
  state.cls = 0;
}

const onHidden = () => {
  if (document.visibilityState !== 'hidden') return;
  reportFinalVitals();
  flush({ beacon: true });
};

export function startPerfCollector({ sampleRate = 1 } = {}) {
  if (state.enabled) {
    state.sampleRate = sampleRate;
    return;
  }
  state.enabled = true;
  state.sampleRate = sampleRate;
  attachObservers();
  state.timer = setInterval(() => flush(), FLUSH_MS);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
}

export function stopPerfCollector({ drain = false } = {}) {
  if (!state.enabled) return;
  if (drain) flush({ beacon: true });
  state.enabled = false;
  for (const obs of state.observers) {
    try {
      obs.disconnect();
    } catch {
      /* already gone */
    }
  }
  state.observers = [];
  clearInterval(state.timer);
  state.timer = null;
  document.removeEventListener('visibilitychange', onHidden);
  window.removeEventListener('pagehide', onHidden);
  // Anything still buffered was collected under the old setting; it is not sent.
  state.buffer = [];
  state.resources.clear();
  state.route = null;
}

export const perfEnabled = () => state.enabled;

// ---------------------------------------------------------------------------
// Route transitions
// ---------------------------------------------------------------------------

// "Page open" is not "React rendered" — a spinner renders instantly. A route
// counts as open once the new screen has painted *and* the requests it kicked
// off have come back. That is measured without every screen having to
// cooperate: api.js reports how many requests are in flight, and the clock
// stops at the first idle moment after the transition has painted.

let inflight = 0;
let painted = false;

// A transition that never goes quiet — a hung request, a screen that polls — is
// still recorded, flagged, rather than left unmeasured forever.
const ROUTE_TIMEOUT_MS = 15_000;

/** Begin timing an in-app navigation, when the router's location changes. */
export function startRoute(pathname) {
  if (!state.enabled) return;
  painted = false;
  state.route = {
    name: screenName(pathname),
    startedAt: performance.now(),
    settled: false,
    timeout: setTimeout(() => markPageReady({ timedOut: true }), ROUTE_TIMEOUT_MS),
  };
}

/** Stop the route clock and record the sample. */
export function markPageReady({ timedOut = false } = {}) {
  const route = state.route;
  if (!state.enabled || !route || route.settled) return;
  route.settled = true;
  clearTimeout(route.timeout);
  state.route = null;
  push({
    kind: 'route',
    name: route.name,
    durationMs: performance.now() - route.startedAt,
    detail: timedOut ? { timedOut: true } : {},
  });
}

function maybeSettleRoute() {
  if (state.route && painted && inflight === 0) markPageReady();
}

/**
 * Mark the transition as painted. Two frames after the router commits, whatever
 * the new screen renders is on screen; from there only outstanding requests
 * hold the clock open.
 */
export function settleRoute() {
  if (!state.enabled || !state.route) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      painted = true;
      maybeSettleRoute();
    })
  );
}

/** api.js calls these around every request so the route clock can see them. */
export function noteRequestStart() {
  inflight += 1;
}
export function noteRequestEnd() {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) maybeSettleRoute();
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Record one API round trip as the browser saw it. `serverMs` comes from the
 * Server-Timing header, so the panel can say how much of a slow request was the
 * server and how much was the network.
 */
export function recordApiTiming({ method, url, durationMs, status, serverMs, bytes }) {
  if (!state.enabled) return;
  push({
    kind: 'api',
    name: apiName(method, url),
    durationMs,
    serverMs: serverMs ?? null,
    transferBytes: bytes || 0,
    status,
  });
}
