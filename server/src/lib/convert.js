import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpError } from './util.js';

// LibreOffice does the PPTX -> PDF rendering. It is present in the production
// image (see Dockerfile); on a dev host install it and/or point SOFFICE_PATH at
// the binary. When it is missing we fail loudly rather than silently storing the
// original format the user did not ask for.
const CANDIDATES = [
  process.env.SOFFICE_PATH,
  'soffice',
  'libreoffice',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

const CONVERT_TIMEOUT_MS = Number(process.env.PDF_CONVERT_TIMEOUT_MS || 120_000);

let resolved;

const run = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })
    );
  });

const executable = async (p) => {
  try {
    await fsp.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Probing with `soffice --version` is not an option: on Alpine it aborts with a
// UNO RuntimeException even on installs that convert perfectly well. So resolve
// the binary from the filesystem and let a real conversion report real failures.
async function locate(candidate) {
  if (candidate.includes(path.sep)) return (await executable(candidate)) ? candidate : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const full = path.join(dir, candidate);
    if (await executable(full)) return full;
  }
  return null;
}

/** Path to an soffice binary, or null. Memoized after the first probe. */
export async function sofficeBin() {
  if (resolved !== undefined) return resolved;
  for (const candidate of CANDIDATES) {
    const found = await locate(candidate);
    if (found) {
      resolved = found;
      return resolved;
    }
  }
  resolved = null;
  return resolved;
}

export const pdfConversionAvailable = async () => Boolean(await sofficeBin());

/**
 * Converts an office document to PDF. Returns the PDF's path inside a temp
 * working directory; the caller moves the file out and removes `workDir`.
 */
export async function convertToPdf(inputPath, originalName = 'document.pptx') {
  const bin = await sofficeBin();
  if (!bin) throw httpError(503, 'PDF conversion is unavailable — LibreOffice is not installed on this server');

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'diomedes-convert-'));
  const profile = path.join(work, 'profile');
  // soffice derives the output name from the input name, so give the input the
  // extension it expects and a stem we can predict.
  const ext = path.extname(originalName) || '.pptx';
  const src = path.join(work, `in${ext}`);

  try {
    await fsp.copyFile(inputPath, src);
    await run(
      bin,
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to',
        'pdf',
        '--outdir',
        work,
        src,
      ],
      // LibreOffice writes into HOME regardless of the profile flag; point it at
      // the throwaway work dir so an unwritable HOME cannot break conversion.
      { cwd: work, env: { ...process.env, HOME: work } }
    );

    const out = path.join(work, 'in.pdf');
    const stat = await fsp.stat(out).catch(() => null);
    if (!stat || stat.size === 0) throw httpError(422, 'Could not convert this file to PDF');
    return { pdfPath: out, workDir: work, size: stat.size };
  } catch (err) {
    await fsp.rm(work, { recursive: true, force: true });
    if (err.status) throw err;
    if (err.killed) throw httpError(504, 'PDF conversion timed out');
    throw httpError(422, `Could not convert this file to PDF: ${err.message}`);
  }
}
