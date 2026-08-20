// Display formatting shared by the workspace info panel.
//
// Kept apart from the components so the rounding rules are testable and so two
// panels never disagree about what "1.2 MB" means.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Bytes as a human figure. Decimal units, because storage vendors use them. */
export function formatBytes(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log10(n) / 3));
  const scaled = n / 1000 ** i;
  // Whole bytes never get a decimal point — "512.0 B" reads as a mistake.
  return `${i === 0 ? Math.round(scaled) : scaled.toFixed(digits)} ${UNITS[i]}`;
}

/**
 * A duration in milliseconds. Sub-millisecond values keep a decimal, seconds
 * take over past 1000ms — nobody reads "1543.2 ms" as a second and a half.
 */
export function formatMs(value, { unit = 'ms' } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  // CLS and friends are unitless scores, not durations.
  if (unit === 'score') return n.toFixed(3);
  if (n >= 60_000) return `${(n / 60_000).toFixed(1)} min`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  if (n >= 100) return `${Math.round(n)} ms`;
  if (n >= 1) return `${n.toFixed(1)} ms`;
  return `${n.toFixed(2)} ms`;
}

/** Thousands separators, and an em dash for nothing at all. */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

/** "3 days", "4 hours", "12 minutes" — for uptimes and ages. */
export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/** A short absolute date; the panel is a dashboard, not a feed. */
export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
