// Workspace-wide settings, stored as a single JSON blob under settings['workspace'].
//
// Flags are stored positively — `true` means the capability is on — even though
// the UI phrases one of them as "turn off live pointers". Positive storage means
// a missing key reads as "everything on", which is what a workspace that
// predates this feature should get.
import { q } from '../db.js';

export const DEFAULT_WORKSPACE_NAME = 'Diomedes';

export const DEFAULT_DATA_SAVINGS = {
  // Broadcast and render other people's mouse pointers while they read.
  livePointers: true,
  // Accept new file/document uploads. Turning this off never touches files that
  // are already stored — they keep being served, viewed and downloaded.
  fileUploads: true,
};

export const normalizeWorkspace = (value) => ({
  name: value?.name?.trim() || DEFAULT_WORKSPACE_NAME,
  dataSavings: {
    livePointers: value?.dataSavings?.livePointers !== false,
    fileUploads: value?.dataSavings?.fileUploads !== false,
  },
});

export async function getWorkspace() {
  const { rows } = await q("SELECT value FROM settings WHERE key = 'workspace'");
  return normalizeWorkspace(rows[0]?.value);
}

export const getDataSavings = async () => (await getWorkspace()).dataSavings;

export const uploadsEnabled = async () => (await getDataSavings()).fileUploads;

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
