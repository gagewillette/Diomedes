import { Router } from 'express';
import { asyncRoute, httpError } from '../lib/util.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { getPerformance } from '../lib/workspace.js';
import { normalizeBatch, insertSamples, clearSamples, flush, prune } from '../lib/perf.js';
import { perfOverview } from '../lib/perfStats.js';

const router = Router();

/**
 * Ingest a batch of browser samples.
 *
 * Any signed-in user posts here — it is their own browser being measured. When
 * logging is switched off the batch is discarded and the response says so, so
 * the collector can stop sending without waiting for the settings event.
 */
router.post(
  '/samples',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { logging, sampleRate } = await getPerformance();
    if (!logging) return res.json({ enabled: false, stored: 0, sampleRate });

    const rows = normalizeBatch(req.body?.samples);
    if (rows.length) await insertSamples('client', rows, req.user.id);
    res.json({ enabled: true, stored: rows.length, sampleRate });
  })
);

// The computed panel. Workspace-wide numbers, so owners/admins only.
router.get(
  '/overview',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    // Push anything still sitting in the server's write buffer first, so an
    // admin who reloads right after a slow request actually sees it.
    await flush().catch(() => {});
    const [overview, settings] = await Promise.all([perfOverview(req.query.window), getPerformance()]);
    res.json({ ...overview, settings });
  })
);

// Housekeeping: drop everything, or drop only what has aged out.
router.delete(
  '/samples',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const mode = req.query.mode || 'all';
    if (mode === 'expired') await prune();
    else if (mode === 'all') await clearSamples();
    else throw httpError(400, "mode must be 'all' or 'expired'");
    res.json({ ok: true, mode });
  })
);

export default router;
