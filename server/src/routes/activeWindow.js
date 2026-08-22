import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { asyncRoute, httpError } from '../lib/util.js';
import { claim, heartbeat, release, CLAIM_TTL_SECONDS, HEARTBEAT_MS } from '../lib/sessionLock.js';

const router = Router();

// Client ids are minted by the browser, so treat them as untrusted input: a
// bounded opaque string is all the lock needs.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const readClientId = (req) => {
  const clientId = req.body?.clientId;
  if (!CLIENT_ID_RE.test(clientId || '')) throw httpError(400, 'A valid clientId is required');
  return clientId;
};

// A short human label for the *other* window's benefit ("Chrome on macOS").
// Trimmed hard — it is only ever rendered as plain text in the takeover prompt.
const readLabel = (req) => {
  const label = req.body?.label;
  return typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : null;
};

// Claim the account for this window. `force: true` is the "Switch" button:
// it takes the account over from whichever window currently holds it.
router.post(
  '/claim',
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await claim(req.user.id, readClientId(req), {
      force: req.body?.force === true,
      label: readLabel(req),
    });
    res.json({ ...result, heartbeatMs: HEARTBEAT_MS, ttlSeconds: CLAIM_TTL_SECONDS });
  })
);

// Renew. Answers `blocked` if another window has taken over in the meantime.
router.post(
  '/heartbeat',
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await heartbeat(req.user.id, readClientId(req), { label: readLabel(req) });
    res.json({ ...result, heartbeatMs: HEARTBEAT_MS, ttlSeconds: CLAIM_TTL_SECONDS });
  })
);

// Give the account back when a window closes, so the next one does not have to
// wait out the TTL. Called on unload via sendBeacon (with an explicit JSON
// blob, so express.json still parses it) and so must stay cheap.
router.post(
  '/release',
  requireAuth,
  asyncRoute(async (req, res) => {
    await release(req.user.id, readClientId(req));
    res.json({ ok: true });
  })
);

export default router;
