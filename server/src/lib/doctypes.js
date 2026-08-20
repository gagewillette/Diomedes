import path from 'node:path';

export const PDF_MIME = 'application/pdf';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const PPT_MIME = 'application/vnd.ms-powerpoint';

// What /pages/:id/documents accepts. The extension decides, not the
// browser-supplied mime, which is easily wrong or absent.
const DOC_TYPES = {
  '.pdf': { mime: PDF_MIME, kind: 'pdf' },
  '.pptx': { mime: PPTX_MIME, kind: 'pptx' },
  '.ppt': { mime: PPT_MIME, kind: 'pptx' },
};

/** `{ mime, kind }` for an accepted document filename, else null. */
export const docTypeFor = (filename) => DOC_TYPES[path.extname(filename || '').toLowerCase()] || null;

// Only these render in the browser tab. Everything else — PPTX above all — is
// forced to download, so an upload can never be served as active content.
const INLINE_MIMES = new Set([PDF_MIME, 'text/plain']);
// SVG is markup: navigating to one runs any script inside it on our origin, so
// it stays out of the inline set even though it is an image.
const NEVER_INLINE = new Set(['image/svg+xml', 'image/svg']);

/**
 * Whether a stored file may be served with `Content-Disposition: inline`. Only
 * affects top-level navigation — an <img>/<video> subresource renders either way.
 */
export const inlineAllowed = (mime) =>
  !NEVER_INLINE.has(mime) && (INLINE_MIMES.has(mime) || /^(image|video|audio)\//.test(mime || ''));
