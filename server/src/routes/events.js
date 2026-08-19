import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { addClient } from '../lib/events.js';

const router = Router();

// Long-lived SSE stream. The browser reconnects on its own if this drops.
router.get('/', requireAuth, (req, res) => addClient(req, res));

export default router;
