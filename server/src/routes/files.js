import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../db.js';
import { asyncRoute, httpError } from '../lib/util.js';
import { requireAuth, assertSpaceRole, spaceRole, getPage, resolveUser } from '../lib/auth.js';

export const STORAGE_PATH = process.env.STORAGE_PATH || path.resolve(process.cwd(), 'data/storage');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.join(STORAGE_PATH, 'tmp')),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});

const router = Router();

router.post(
  '/pages/:id/attachments',
  requireAuth,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw httpError(400, 'No file uploaded');
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');

    const safeName = path.basename(req.file.originalname || 'file').replace(/[^\w.\- ()]/g, '_') || 'file';
    const dir = path.join(STORAGE_PATH, page.space_id);
    await fsp.mkdir(dir, { recursive: true });
    const diskName = `${crypto.randomUUID()}${path.extname(safeName)}`;
    await fsp.rename(req.file.path, path.join(dir, diskName));

    const { rows } = await q(
      `INSERT INTO attachments (page_id, space_id, filename, mime, size, disk_path, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, mime, size`,
      [
        page.id,
        page.space_id,
        safeName,
        req.file.mimetype || 'application/octet-stream',
        req.file.size,
        path.join(page.space_id, diskName),
        req.user.id,
      ]
    );
    const att = rows[0];
    res.status(201).json({
      attachment: att,
      url: `/api/files/${att.id}/${encodeURIComponent(att.filename)}`,
    });
  })
);

// Serves a file to space members, or to anyone if the owning page is shared publicly.
router.get(
  '/files/:id/:filename',
  asyncRoute(async (req, res) => {
    const { rows } = await q('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    const att = rows[0];
    if (!att) throw httpError(404, 'File not found');

    let allowed = false;
    const user = await resolveUser(req);
    if (user) allowed = Boolean(await spaceRole(user, att.space_id));
    if (!allowed && att.page_id) {
      const { rows: shared } = await q('SELECT 1 FROM pages WHERE id = $1 AND share_token IS NOT NULL', [att.page_id]);
      allowed = shared.length > 0;
    }
    if (!allowed) throw httpError(403, 'Not allowed');

    const abs = path.join(STORAGE_PATH, att.disk_path);
    if (!fs.existsSync(abs)) throw httpError(404, 'File missing from storage');
    res.setHeader('Content-Type', att.mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=31536000');
    fs.createReadStream(abs).pipe(res);
  })
);

// Public read-only page access by share token — no auth.
router.get(
  '/public/:token',
  asyncRoute(async (req, res) => {
    const { rows } = await q(
      `SELECT p.id, p.title, p.icon, p.content, p.updated_at FROM pages p
       WHERE p.share_token = $1 AND p.deleted_at IS NULL`,
      [req.params.token]
    );
    if (!rows[0]) throw httpError(404, 'This link is invalid or has been revoked');
    const { rows: ws } = await q("SELECT value FROM settings WHERE key = 'workspace'");
    res.json({ page: rows[0], workspaceName: ws[0]?.value?.name || 'Diomedes' });
  })
);

export default router;
