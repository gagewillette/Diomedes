// One SSE connection per tab, opened once the user is known. The server pushes
// membership/role changes so the UI updates without a manual refresh.
const EVENT_TYPES = [
  'spaces-changed',
  'space-members-changed',
  'users-changed',
  'account-changed',
  'workspace-settings-changed',
  'pages-changed',
  'page-moved',
];

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30_000;

// `onEvent(type, detail)` is also called with the synthetic type 'reconnected'
// after a dropped stream comes back, since events sent while we were offline
// are gone — the caller should re-fetch instead of trusting its cached state.
export function startRealtime(onEvent) {
  if (typeof EventSource === 'undefined') return () => {};

  let source = null;
  let timer = null;
  let attempts = 0;
  let everOpened = false;
  let stopped = false;

  const open = () => {
    if (stopped || source) return;
    const es = new EventSource('/api/events');
    source = es;

    es.onopen = () => {
      const wasDropped = everOpened;
      everOpened = true;
      attempts = 0;
      if (wasDropped) onEvent('reconnected', {});
    };

    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        let detail = {};
        try {
          detail = JSON.parse(e.data);
        } catch {
          /* keep the empty detail */
        }
        onEvent(type, detail);
      });
    }

    // Take over retries from the browser so we can back off and eventually give
    // up — a stream that keeps 401ing means the session is gone, and hammering
    // it forever is worse than waiting for the next page load.
    es.onerror = () => {
      es.close();
      if (source === es) source = null;
      if (stopped) return;
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) return;
      timer = setTimeout(open, Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS));
    };
  };

  // Coming back to a backgrounded tab is the moment stale permissions are most
  // visible, so retry immediately instead of waiting out the backoff.
  const onWake = () => {
    if (stopped || source || document.visibilityState === 'hidden') return;
    clearTimeout(timer);
    attempts = 0;
    open();
  };
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);

  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('online', onWake);
    source?.close();
    source = null;
  };
}
