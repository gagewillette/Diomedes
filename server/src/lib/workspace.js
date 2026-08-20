// Workspace-wide settings, stored as a single JSON blob under settings['workspace'].
//
// Flags are stored positively — `true` means the capability is on — even though
// the UI phrases one of them as "turn off live pointers". Positive storage means
// a missing key reads as "everything on", which is what a workspace that
// predates this feature should get.
import { q } from '../db.js';

export const DEFAULT_WORKSPACE_NAME = 'Diomedes';

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
});

export async function getWorkspace() {
  const { rows } = await q("SELECT value FROM settings WHERE key = 'workspace'");
  return normalizeWorkspace(rows[0]?.value);
}

export const getDataSavings = async () => (await getWorkspace()).dataSavings;

export const uploadsEnabled = async () => (await getDataSavings()).fileUploads;

export const getPerformance = async () => (await getWorkspace()).performance;

export const perfLoggingEnabled = async () => (await getPerformance()).logging;

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
