export const DEFAULT_PREFS = {
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.65,
  editorWidth: 'normal',
  smoothCaret: true,
  animations: true,
  keymap: 'default',
};

export const FONT_STACKS = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  humanist: '"Segoe UI", Verdana, "Trebuchet MS", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace',
};

export const FONT_LABELS = {
  system: 'System sans (default)',
  serif: 'Serif (Georgia)',
  humanist: 'Humanist (Segoe/Verdana)',
  mono: 'Monospace',
};

export const WIDTH_TO_CONTAINER = { narrow: 'sm', normal: 'md', wide: 'xl' };

// Keyboard emulation. 'default' is the ordinary editor; 'vim' turns on modal
// editing inside the document and j/k navigation in the page tree.
export const KEYMAP_LABELS = {
  default: 'Default (no emulation)',
  vim: 'Vim',
};

export const VIM_CHALLENGE = 'How do you quit Vim without saving?';

/**
 * The gate in front of vim mode. Someone who cannot get out of vim unaided is
 * better off not being dropped into normal mode mid-sentence, so switching the
 * emulation on costs one correct answer.
 *
 * Accepts the ex commands and the ZQ shorthand. A leading ':' is optional —
 * people type the command the way they would from normal mode.
 */
export function isVimQuitAnswer(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return false;
  if (/^zq$/i.test(raw)) return true;
  const cmd = raw.replace(/^:+/, '').replace(/\s+/g, '').toLowerCase();
  return /^(q|quit|qa|qall|quita|quitall)!$/.test(cmd);
}

export const mergePrefs = (stored) => ({ ...DEFAULT_PREFS, ...(stored || {}) });
