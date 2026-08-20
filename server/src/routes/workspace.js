import { Router } from 'express';
import { asyncRoute, httpError } from '../lib/util.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { getWorkspace, setDataSavings } from '../lib/workspace.js';
import { publish } from '../lib/events.js';

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

export default router;
