// Workspace-wide settings as the client sees them. The server is the authority;
// these defaults only cover the moment before /api/auth/me answers, and public
// share pages, which have no workspace context at all.

export const DEFAULT_WORKSPACE = {
  name: 'Diomedes',
  // Stored positively: true means the capability is on.
  dataSavings: { livePointers: true, fileUploads: true },
  // Performance logging is on by default; an owner or admin turns it off in
  // workspace settings.
  performance: { logging: true, sampleRate: 1 },
};

export const mergeWorkspace = (workspace) => ({
  name: workspace?.name || DEFAULT_WORKSPACE.name,
  dataSavings: {
    livePointers: workspace?.dataSavings?.livePointers !== false,
    fileUploads: workspace?.dataSavings?.fileUploads !== false,
  },
  performance: {
    logging: workspace?.performance?.logging !== false,
    sampleRate:
      typeof workspace?.performance?.sampleRate === 'number'
        ? Math.min(1, Math.max(0, workspace.performance.sampleRate))
        : DEFAULT_WORKSPACE.performance.sampleRate,
  },
});
