import crypto from 'node:crypto';

// Flatten a TipTap JSON document into plain text for search indexing.
export function extractText(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];
  if (typeof node.text === 'string') parts.push(node.text);
  if (node.attrs) {
    // index diagram code and callout titles too
    if (typeof node.attrs.code === 'string') parts.push(node.attrs.code);
    if (typeof node.attrs.title === 'string') parts.push(node.attrs.title);
  }
  // Footnote bodies are indexed like any other text — a citation nobody can
  // search for is a citation nobody will find. The label rides along so a
  // ts_headline fragment drawn from a note does not read as body prose in the
  // search results.
  if (node.type === 'footnotes') parts.push('Footnotes:');
  if (Array.isArray(node.content)) {
    for (const child of node.content) parts.push(extractText(child));
  }
  return parts.filter(Boolean).join(' ');
}

export function slugify(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'space';
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

export const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

export const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Bytes as a human figure, for messages that name a limit. Decimal units, so a
 * server message and the admin UI (client/src/lib/format.js) read the same.
 */
export function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const scaled = n / 1000 ** i;
  return `${i === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[i]}`;
}
