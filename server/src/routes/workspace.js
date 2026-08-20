import { Router } from 'express';
import { asyncRoute, httpError } from '../lib/util.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { getWorkspace, setDataSavings, setPerformance } from '../lib/workspace.js';
import { publish } from '../lib/events.js';
import { workspaceInfo } from '../lib/workspaceInfo.js';

const router = Router();

// Everyone reads the settings — the client needs the flags to know whether to
// broadcast pointers or offer an upload button.
router.get(
  '/settings',
  requireAuth,
  asyncRoute(async (_req, res) => res.json({ workspace: await getWorkspace() }))
);

// Only workspace owners/admins change them; it is a workspace-wide switch.
router.patch(
  '/settings/data-savings',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const patch = req.body?.dataSavings;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw httpError(400, 'dataSavings must be an object');
    }
    const known = ['livePointers', 'fileUploads'];
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((k) => !known.includes(k))) {
      throw httpError(400, `dataSavings accepts only: ${known.join(', ')}`);
    }
    if (keys.some((k) => typeof patch[k] !== 'boolean')) {
      throw httpError(400, 'data savings flags must be booleans');
    }

    const workspace = await setDataSavings(patch);
    // Everyone is affected, so this one goes to every connected browser rather
    // than a computed audience.
    publish({ type: 'workspace-settings-changed', workspace });
    res.json({ workspace });
  })
);

// Same shape as the data-savings switch, for the performance-logging group.
router.patch(
  '/settings/performance',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const patch = req.body?.performance;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw httpError(400, 'performance must be an object');
    }
    const keys = Object.keys(patch);
    const known = ['logging', 'sampleRate'];
    if (!keys.length || keys.some((k) => !known.includes(k))) {
      throw httpError(400, `performance accepts only: ${known.join(', ')}`);
    }
    if ('logging' in patch && typeof patch.logging !== 'boolean') {
      throw httpError(400, 'logging must be a boolean');
    }
    if ('sampleRate' in patch && (typeof patch.sampleRate !== 'number' || !Number.isFinite(patch.sampleRate))) {
      throw httpError(400, 'sampleRate must be a number between 0 and 1');
    }

    const workspace = await setPerformance(patch);
    // Browsers start or stop their collectors off the back of this event.
    publish({ type: 'workspace-settings-changed', workspace });
    res.json({ workspace });
  })
);

// Workspace-wide inventory and storage figures. Admin-only: a member has no
// business learning about spaces they cannot open.
router.get(
  '/info',
  requireAuth,
  requireAdmin,
  asyncRoute(async (_req, res) => {
    const [info, workspace] = await Promise.all([workspaceInfo(), getWorkspace()]);
    res.json({ workspace, ...info });
  })
);

export default router;
