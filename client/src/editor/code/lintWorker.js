// The lint worker. Nothing parses on the main thread, ever.
//
// A parser is the one thing in the editor that can be handed adversarial input
// by accident — a 200 KB minified bundle pasted into a page is not malice, it
// is Tuesday — and a parser that goes quadratic on the main thread freezes the
// tab for everyone looking at that page. Off-thread, the worst case is a worker
// that is busy for a while and a block that shows no diagnostics yet.
//
// The protocol is deliberately tiny, and offsets-only:
//
//   → { id, lang, qualifier, code, version }
//   ← { id, version, diagnostics: [{ from, to, severity, message, source }] }
//
// `version` is echoed back untouched so the main thread can drop a reply that
// describes text the user has since edited. The worker itself keeps no state
// about a block, which is what makes latest-wins trivial: it answers whatever
// it is asked, in order, and the main thread decides what is still true.
import { diagnose } from './diagnostics.js';

// The worker idles out rather than living for the whole session. A page with
// one YAML block should not hold a thread open while someone reads for an hour.
const IDLE_MS = 60_000;
let idleTimer = null;
let pending = 0;

const armIdleTimer = () => {
  clearTimeout(idleTimer);
  if (pending > 0) return;
  idleTimer = setTimeout(() => {
    // The plugin re-spawns on the next request; see spawnLintWorker.
    self.postMessage({ type: 'idle' });
    self.close();
  }, IDLE_MS);
};

self.onmessage = async (event) => {
  const { id, lang, qualifier, code, version } = event.data || {};
  if (!id) return;
  clearTimeout(idleTimer);
  pending += 1;
  let diagnostics = [];
  try {
    diagnostics = await diagnose(lang, code ?? '', qualifier ?? '');
  } catch {
    // `diagnose` already swallows adapter failures; this is the last line
    // against a dynamic import that could not be fetched at all. A checker that
    // cannot run reports nothing — it must not take the worker with it.
    diagnostics = [];
  } finally {
    pending -= 1;
  }
  self.postMessage({ id, version, diagnostics });
  armIdleTimer();
};

armIdleTimer();
