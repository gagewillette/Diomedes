// Workspace-wide settings as the client sees them. The server is the authority;
// these defaults only cover the moment before /api/auth/me answers, and public
// share pages, which have no workspace context at all.

// Mirrors WORKSPACE_NAME_MAX on the server, which rejects anything longer.
export const WORKSPACE_NAME_MAX = 64;

export const DEFAULT_WORKSPACE = {
  name: 'Diomedes',
  // Stored positively: true means the capability is on.
  dataSavings: { livePointers: true, fileUploads: true },
  // Performance logging is on by default; an owner or admin turns it off in
  // workspace settings.
  performance: { logging: true, sampleRate: 1 },
  // Highlighting on, linting on. Share pages use these defaults verbatim and
  // then turn linting off themselves — see CODE_INTELLIGENCE_READONLY below.
  codeIntelligence: { highlighting: true, linting: true, maxBytes: 100_000 },
};

// Mirrors CODE_MAX_BYTES_MIN/MAX on the server, which clamps to the same range.
export const CODE_MAX_BYTES_MIN = 10_000;
export const CODE_MAX_BYTES_MAX = 1_000_000;

// A public share page has no workspace context and nobody to fix a false
// positive, so it colours code and checks nothing.
export const CODE_INTELLIGENCE_READONLY = {
  ...DEFAULT_WORKSPACE.codeIntelligence,
  linting: false,
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
  codeIntelligence: {
    highlighting: workspace?.codeIntelligence?.highlighting !== false,
    linting: workspace?.codeIntelligence?.linting !== false,
    maxBytes:
      typeof workspace?.codeIntelligence?.maxBytes === 'number'
        && Number.isFinite(workspace.codeIntelligence.maxBytes)
        ? Math.min(CODE_MAX_BYTES_MAX, Math.max(CODE_MAX_BYTES_MIN, Math.round(workspace.codeIntelligence.maxBytes)))
        : DEFAULT_WORKSPACE.codeIntelligence.maxBytes,
  },
});
