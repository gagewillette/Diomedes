// Workspace-wide settings, stored as a single JSON blob under settings['workspace'].
//
// Flags are stored positively — `true` means the capability is on — even though
// the UI phrases one of them as "turn off live pointers". Positive storage means
// a missing key reads as "everything on", which is what a workspace that
// predates this feature should get.
import { q } from '../db.js';

export const DEFAULT_WORKSPACE_NAME = 'Diomedes';

// The name shows up in the header, on the login screen and on public share
// pages, so it stays short enough to render in all three.
export const WORKSPACE_NAME_MAX = 64;

// Performance logging is separate from data savings: it is a diagnostics
// switch, not a bandwidth one, and it is the only workspace flag that governs
// whether we write rows about our own users.
export const DEFAULT_PERFORMANCE = {
  // Collect timing samples from browsers and from the server.
  logging: true,
  // Fraction of client samples actually sent, 0..1. A busy workspace can turn
  // this down instead of turning logging off entirely.
  sampleRate: 1,
};

export const DEFAULT_DATA_SAVINGS = {
  // Broadcast and render other people's mouse pointers while they read.
  livePointers: true,
  // Accept new file/document uploads. Turning this off never touches files that
  // are already stored — they keep being served, viewed and downloaded.
  fileUploads: true,
};

// Upload limits. `maxBytes` is the largest single file the workspace accepts,
// checked twice: once against the declared Content-Length before a body byte is
// read, and once by multer against the bytes actually arriving. The default is
// the ceiling, which restates the figure that used to be hard-coded in the
// upload route — so an existing install keeps accepting what it always did.
//
// Bytes are decimal throughout (1 MB = 1,000,000), matching how both the server
// message and the admin UI format them: an admin who sets 250 MB should not be
// told the limit is 262.1 MB.
export const DEFAULT_UPLOADS = {
  maxBytes: 512_000_000,
};

// The floor keeps the setting usable (a workspace that cannot take a 1 MB image
// has effectively turned uploads off, and there is a switch for that) and the
// ceiling bounds what a single request can write into the storage volume.
export const UPLOAD_MAX_BYTES_MIN = 1_000_000;
export const UPLOAD_MAX_BYTES_MAX = 512_000_000;

const normalizeUploadMaxBytes = (bytes) => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return DEFAULT_UPLOADS.maxBytes;
  return Math.min(UPLOAD_MAX_BYTES_MAX, Math.max(UPLOAD_MAX_BYTES_MIN, Math.round(bytes)));
};

// Code intelligence is a *compute* switch, not a bandwidth one: everything it
// governs happens in the reader's browser. It sits beside data savings because
// the trade-off is the same shape — an admin trading a nicety for a cheaper
// page on old machines — but it is its own group so a write to one can never
// clobber the other.
export const DEFAULT_CODE_INTELLIGENCE = {
  // Colorise code blocks by language. Off means no grammar is ever downloaded
  // and code renders as plain monospaced text.
  highlighting: true,
  // Parse each block with its language's parser and show inline diagnostics.
  linting: true,
  // Bytes above which a block is highlighted but never parsed.
  maxBytes: 100_000,
};

// The floor keeps the setting meaningful (below ~10 KB almost nothing would be
// checked) and the ceiling keeps a mistyped number from handing the main thread
// a megabyte to parse.
export const CODE_MAX_BYTES_MIN = 10_000;
export const CODE_MAX_BYTES_MAX = 1_000_000;

const normalizeMaxBytes = (bytes) => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return DEFAULT_CODE_INTELLIGENCE.maxBytes;
  return Math.min(CODE_MAX_BYTES_MAX, Math.max(CODE_MAX_BYTES_MIN, Math.round(bytes)));
};

const normalizeSampleRate = (rate) => {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return DEFAULT_PERFORMANCE.sampleRate;
  return Math.min(1, Math.max(0, Math.round(rate * 100) / 100));
};

export const normalizeWorkspace = (value) => ({
  name: value?.name?.trim() || DEFAULT_WORKSPACE_NAME,
  dataSavings: {
    livePointers: value?.dataSavings?.livePointers !== false,
    fileUploads: value?.dataSavings?.fileUploads !== false,
  },
  performance: {
    logging: value?.performance?.logging !== false,
    sampleRate: normalizeSampleRate(value?.performance?.sampleRate),
  },
  codeIntelligence: {
    highlighting: value?.codeIntelligence?.highlighting !== false,
    linting: value?.codeIntelligence?.linting !== false,
    maxBytes: normalizeMaxBytes(value?.codeIntelligence?.maxBytes),
  },
  uploads: {
    maxBytes: normalizeUploadMaxBytes(value?.uploads?.maxBytes),
  },
});

export async function getWorkspace() {
  const { rows } = await q("SELECT value FROM settings WHERE key = 'workspace'");
  return normalizeWorkspace(rows[0]?.value);
}

export const getDataSavings = async () => (await getWorkspace()).dataSavings;

export const uploadsEnabled = async () => (await getDataSavings()).fileUploads;

export const getPerformance = async () => (await getWorkspace()).performance;

export const perfLoggingEnabled = async () => (await getPerformance()).logging;

export const getCodeIntelligence = async () => (await getWorkspace()).codeIntelligence;

export const getUploads = async () => (await getWorkspace()).uploads;

export const uploadMaxBytes = async () => (await getUploads()).maxBytes;

/**
 * Merge a partial data-savings patch into the stored blob, leaving the workspace
 * name (and any future keys) untouched. Returns the settings as they now stand.
 */
export async function setDataSavings(patch) {
  const current = await getWorkspace();
  const next = {
    ...current,
    dataSavings: {
      ...current.dataSavings,
      ...(typeof patch?.livePointers === 'boolean' ? { livePointers: patch.livePointers } : {}),
      ...(typeof patch?.fileUploads === 'boolean' ? { fileUploads: patch.fileUploads } : {}),
    },
  };
  await q(
    `INSERT INTO settings (key, value) VALUES ('workspace', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [next]
  );
  return next;
}

/**
 * Rename the workspace, leaving every other key in the blob untouched. The name
 * is trimmed and length-checked by the caller; a blank one is rejected there
 * rather than silently falling back to the default.
 */
export async function setWorkspaceName(name) {
  const current = await getWorkspace();
  const next = { ...current, name: name.trim() };
  await q(
    `INSERT INTO settings (key, value) VALUES ('workspace', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [next]
  );
  return next;
}

/**
 * Same merge-and-store as setDataSavings, for the performance group. Kept
 * separate so a write to one group can never clobber the other.
 */
export async function setPerformance(patch) {
  const current = await getWorkspace();
  const next = {
    ...current,
    performance: {
      ...current.performance,
      ...(typeof patch?.logging === 'boolean' ? { logging: patch.logging } : {}),
      ...(typeof patch?.sampleRate === 'number' ? { sampleRate: normalizeSampleRate(patch.sampleRate) } : {}),
    },
  };
  await q(
    `INSERT INTO settings (key, value) VALUES ('workspace', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [next]
  );
  return next;
}

/**
 * Same merge-and-store as setDataSavings, for the code-intelligence group.
 * Separate for the same reason: an admin turning linting off must not reset
 * whatever the performance group happened to hold.
 */
export async function setCodeIntelligence(patch) {
  const current = await getWorkspace();
  const next = {
    ...current,
    codeIntelligence: {
      ...current.codeIntelligence,
      ...(typeof patch?.highlighting === 'boolean' ? { highlighting: patch.highlighting } : {}),
      ...(typeof patch?.linting === 'boolean' ? { linting: patch.linting } : {}),
      ...(typeof patch?.maxBytes === 'number' ? { maxBytes: normalizeMaxBytes(patch.maxBytes) } : {}),
    },
  };
  await q(
    `INSERT INTO settings (key, value) VALUES ('workspace', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [next]
  );
  return next;
}

/**
 * Same merge-and-store again, for the upload group. maxBytes is clamped rather
 * than rejected, like the code-block ceiling: an admin who types a huge number
 * gets the maximum, not an error about bounds.
 */
export async function setUploads(patch) {
  const current = await getWorkspace();
  const next = {
    ...current,
    uploads: {
      ...current.uploads,
      ...(typeof patch?.maxBytes === 'number' ? { maxBytes: normalizeUploadMaxBytes(patch.maxBytes) } : {}),
    },
  };
  await q(
    `INSERT INTO settings (key, value) VALUES ('workspace', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [next]
  );
  return next;
}
