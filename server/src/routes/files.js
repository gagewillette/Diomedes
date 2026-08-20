import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../db.js';
import { asyncRoute, httpError } from '../lib/util.js';
import { requireAuth, assertSpaceRole, spaceRole, getPage, resolveUser } from '../lib/auth.js';
import { convertToPdf, pdfConversionAvailable } from '../lib/convert.js';
import { uploadsEnabled, getWorkspace } from '../lib/workspace.js';
import { PDF_MIME, docTypeFor, inlineAllowed } from '../lib/doctypes.js';
import { STORAGE_PATH } from '../lib/storage.js';

export { STORAGE_PATH };

// Documents live under a per-user directory rather than the per-space layout
// used by inline images and videos.
export const userDir = (userId) => path.join('users', userId);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.join(STORAGE_PATH, 'tmp')),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});

// Converted PDFs come out of the OS temp dir, which in a container is often a
// different filesystem from the storage volume — rename() answers EXDEV there.
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

const safeFilename = (name, fallback = 'file') =>
  path.basename(name || fallback).replace(/[^\w.\- ()]/g, '_') || fallback;

const fileUrls = (att) => {
  const base = `/api/files/${att.id}/${encodeURIComponent(att.filename)}`;
  return { url: base, downloadUrl: `${base}?download=1` };
};

// Data-savings gate for new uploads. It runs *before* multer so a rejected file
// is never written to disk. Existing attachments are untouched: the download and
// inline-view routes below stay open whatever this flag says.
const requireUploadsEnabled = asyncRoute(async (_req, _res, next) => {
  if (!(await uploadsEnabled())) {
    throw httpError(403, 'File uploads are turned off for this workspace');
  }
  next();
});

const router = Router();

router.post(
  '/pages/:id/attachments',
  requireAuth,
  requireUploadsEnabled,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw httpError(400, 'No file uploaded');
    const page = await getPage(req.params.id);
    await assertSpaceRole(req.user, page.space_id, 'writer');

    const safeName = safeFilename(req.file.originalname);
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
    res.status(201).json({ attachment: att, ...fileUrls(att) });
  })
);

// Tells the client whether offering "convert to PDF" for a PPTX makes sense.
router.get(
  '/documents/capabilities',
  requireAuth,
  asyncRoute(async (_req, res) => {
    res.json({ pdfConversion: await pdfConversionAvailable() });
  })
);

// Document upload: PDF is stored as-is; a PPTX is stored either as-is or
// converted to PDF here on the server, depending on `storeAs`.
router.post(
  '/pages/:id/documents',
  requireAuth,
  requireUploadsEnabled,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw httpError(400, 'No file uploaded');
    const tmpPath = req.file.path;
    let workDir = null;

    try {
      const page = await getPage(req.params.id);
      await assertSpaceRole(req.user, page.space_id, 'writer');

      const safeName = safeFilename(req.file.originalname, 'document');
      const type = docTypeFor(safeName);
      if (!type) throw httpError(415, 'Only PDF and PowerPoint (.pptx) documents can be uploaded here');

      const storeAs = req.body?.storeAs === 'pdf' ? 'pdf' : 'original';
      const convert = type.kind === 'pptx' && storeAs === 'pdf';

      let sourcePath = tmpPath;
      let filename = safeName;
      let mime = type.mime;
      let size = req.file.size;

      if (convert) {
        const out = await convertToPdf(tmpPath, safeName);
        workDir = out.workDir;
        sourcePath = out.pdfPath;
        filename = `${path.basename(safeName, path.extname(safeName))}.pdf`;
        mime = PDF_MIME;
        size = out.size;
      }

      const relDir = userDir(req.user.id);
      await fsp.mkdir(path.join(STORAGE_PATH, relDir), { recursive: true });
      const diskName = `${crypto.randomUUID()}${path.extname(filename)}`;
      await moveFile(sourcePath, path.join(STORAGE_PATH, relDir, diskName));

      const { rows } = await q(
        `INSERT INTO attachments (page_id, space_id, filename, mime, size, disk_path, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, mime, size`,
        [page.id, page.space_id, filename, mime, size, path.join(relDir, diskName), req.user.id]
      );
      const att = rows[0];
      res.status(201).json({
        attachment: att,
        docKind: mime === PDF_MIME ? 'pdf' : 'pptx',
        converted: convert,
        ...fileUrls(att),
      });
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
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

    // disk_path is written by this module only, but never let a stored value
    // walk outside the storage root.
    const abs = path.resolve(STORAGE_PATH, att.disk_path);
    if (abs !== path.resolve(STORAGE_PATH) && !abs.startsWith(path.resolve(STORAGE_PATH) + path.sep))
      throw httpError(404, 'File not found');
    if (!fs.existsSync(abs)) throw httpError(404, 'File missing from storage');

    const download = req.query.download === '1' || req.query.download === 'true';
    const disposition = !download && inlineAllowed(att.mime) ? 'inline' : 'attachment';
    const ascii = att.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

    res.setHeader('Content-Type', att.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`
    );
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
    const workspace = await getWorkspace();
    res.json({ page: rows[0], workspaceName: workspace.name });
  })
);

export default router;
