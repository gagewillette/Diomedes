// Cross-workspace space transfer.
//
// Three audiences share this file, and they authenticate in three different
// ways, which is the thing to keep straight when changing it:
//
//   /api/spaces/:id/export-keys   a space admin here, on a session
//   /api/export/:secret           another workspace, holding a bearer code
//   /api/spaces/import*           a workspace admin here, on a session
//
// The middle one is the only unauthenticated route in the app that serves page
// content by id, so it is deliberately narrow: it reads the frozen selection on
// the key and nothing else, and it can never be talked into widening it.
import { Router } from 'express';
import { asyncRoute } from '../lib/util.js';
import { requireAuth, requireAdmin, assertSpaceRole } from '../lib/auth.js';
import { publish, adminAudience } from '../lib/events.js';
import {
  buildSnapshot,
  createExportKey,
  exportOrigin,
  listExportKeys,
  noteExportKeyUse,
  resolveExportKey,
  revokeExportKey,
} from '../lib/spaceExport.js';
import { fetchSnapshot, importSnapshot } from '../lib/spaceImport.js';

const router = Router();

// ---- redeeming a key (no session; the code is the credential) ----

// Mounted before the authenticated routes below and deliberately outside
// requireAuth: the caller is another workspace's server, which has no account
// here and never will.
router.get(
  '/export/:secret',
  asyncRoute(async (req, res) => {
    const key = await resolveExportKey(req.params.secret);
    const snapshot = await buildSnapshot(key);
    // Recorded but not awaited — see noteExportKeyUse. A bookkeeping failure is
    // not a reason to refuse a pull that is otherwise valid.
    noteExportKeyUse(key.id).catch(() => {});
    // A snapshot is a point-in-time copy handed to a bearer token; nothing
    // between here and the other workspace should keep one.
    res.set('Cache-Control', 'no-store');
    res.json(snapshot);
  })
);

// ---- everything below needs a session here ----
//
// requireAuth is attached per route rather than with router.use(). This router
// is mounted on /api as a whole, so a blanket router.use() would run on every
// request that enters /api — including the unauthenticated /api/public/:token
// share routes mounted after it, which would start answering 401 to guests.

/**
 * Export keys are space-admin-only. A writer can already read every page in the
 * space, but minting a key is a different act: it hands a slice of the space to
 * people with no account in this workspace at all, revocable only by someone
 * who can see the key list.
 */
const requireSpaceAdmin = (req) => assertSpaceRole(req.user, req.params.id, 'admin');

router.get(
  '/spaces/:id/export-keys',
  requireAuth,
  asyncRoute(async (req, res) => {
    await requireSpaceAdmin(req);
    res.json({ keys: await listExportKeys(req.params.id) });
  })
);

router.post(
  '/spaces/:id/export-keys',
  requireAuth,
  asyncRoute(async (req, res) => {
    await requireSpaceAdmin(req);
    const result = await createExportKey({
      spaceId: req.params.id,
      userId: req.user.id,
      name: req.body?.name,
      pageIds: req.body?.pageIds,
      expiresInDays: req.body?.expiresInDays,
      origin: exportOrigin(req),
    });
    // The plaintext code is in this response and in no other, ever.
    res.status(201).json(result);
  })
);

router.delete(
  '/spaces/:id/export-keys/:keyId',
  requireAuth,
  asyncRoute(async (req, res) => {
    await requireSpaceAdmin(req);
    await revokeExportKey(req.params.id, req.params.keyId);
    res.json({ ok: true });
  })
);

// ---- importing ----

/**
 * Look at what a code would bring in, without writing anything.
 *
 * Importing creates a space full of someone else's pages; being able to see the
 * name and the page count first is the difference between a considered action
 * and pasting a string and hoping. It costs one extra round trip to the source
 * workspace, which is cheap next to an import nobody wanted.
 */
router.post(
  '/spaces/import/preview',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const snapshot = await fetchSnapshot(req.body?.code);
    const withContent = snapshot.pages.filter((p) => p.includeContent).length;
    res.json({
      preview: {
        space: snapshot.space,
        exportName: snapshot.exportName,
        exportedAt: snapshot.exportedAt,
        pages: snapshot.pages.length,
        withContent,
        placeholders: snapshot.pages.length - withContent,
        // The tree, titles only, so the modal can show what is coming.
        outline: snapshot.pages.map((p) => ({
          id: p.id,
          parentId: p.parentId,
          title: p.title,
          icon: p.icon,
          includeContent: p.includeContent,
        })),
      },
    });
  })
);

/**
 * Creating a space is already workspace-admin-only (see POST /api/spaces), and
 * importing one is that same act with content attached — plus an outbound
 * request to an address the code chose, which is its own reason to keep the
 * gate high. See lib/spaceImport.js for how that address is checked.
 */
router.post(
  '/spaces/import',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const snapshot = await fetchSnapshot(req.body?.code);
    const result = await importSnapshot({
      snapshot,
      userId: req.user.id,
      name: req.body?.name,
      icon: req.body?.icon,
    });
    // Same broadcast a new space sends: every admin's sidebar picks it up.
    publish({ type: 'spaces-changed', userIds: await adminAudience([req.user.id]) });
    res.status(201).json(result);
  })
);

export default router;
