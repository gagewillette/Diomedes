export const DEFAULT_PREFS = {
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.65,
  editorWidth: 'normal',
  smoothCaret: true,
  animations: true,
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

export const mergePrefs = (stored) => ({ ...DEFAULT_PREFS, ...(stored || {}) });
