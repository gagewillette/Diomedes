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
