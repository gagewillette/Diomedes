import fsp from 'node:fs/promises';
import path from 'node:path';

export const STORAGE_PATH = process.env.STORAGE_PATH || path.resolve(process.cwd(), 'data/storage');

// Resolve a stored `disk_path` against the storage root, refusing anything that
// escapes it. disk_path is only ever written by the upload routes, but a value
// that has been tampered with in the database must not turn a cleanup pass into
// an arbitrary delete.
export function resolveStoredPath(diskPath, root = STORAGE_PATH) {
  if (typeof diskPath !== 'string' || !diskPath) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, diskPath);
  if (abs === base || !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// Best-effort: the rows are already gone by the time this runs, so a blob that
// cannot be removed is leaked disk space, not a failed request.
export async function removeStoredFiles(diskPaths, root = STORAGE_PATH) {
  let removed = 0;
  for (const diskPath of diskPaths) {
    const abs = resolveStoredPath(diskPath, root);
    if (!abs) continue;
    try {
      await fsp.rm(abs, { force: true });
      removed += 1;
    } catch {
      /* leave it for the next sweep */
    }
  }
  return removed;
}
