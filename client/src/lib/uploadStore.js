import { postWithProgress } from './api.js';
import { formatBytes } from './format.js';
import { DEFAULT_WORKSPACE } from './workspace.js';

// Tracks in-flight file uploads so the UI can show a progress bar instead of
// letting the user click upload again while a large file is still going.
let uploads = [];
// The workspace's per-file ceiling, mirrored here from the settings blob by
// AuthContext. It lives at module scope because uploads are started from
// editor code that runs outside React, and because the check has to happen
// before the request opens: sending 400 MB only to be told 413 costs the user
// the whole upload for an answer we already had.
let maxFileBytes = DEFAULT_WORKSPACE.uploads.maxBytes;
let nextId = 1;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(uploads);
}

/** Called by AuthContext whenever the workspace settings land or change. */
export function setMaxFileBytes(bytes) {
  if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) maxFileBytes = bytes;
}

export function getMaxFileBytes() {
  return maxFileBytes;
}

/** The reason a file cannot be uploaded, or null if it can. */
export function fileTooLargeMessage(file) {
  if (!file || typeof file.size !== 'number' || file.size <= maxFileBytes) return null;
  return `${file.name} is ${formatBytes(file.size)} — this workspace allows up to ${formatBytes(maxFileBytes)} per file.`;
}

export function subscribeUploads(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getUploads() {
  return uploads;
}

export function startUpload(name, size) {
  const id = nextId++;
  uploads = [...uploads, { id, name, size, progress: 0, status: 'uploading', error: null }];
  emit();
  return id;
}

export function updateUploadProgress(id, progress) {
  uploads = uploads.map((u) => (u.id === id ? { ...u, progress } : u));
  emit();
}

export function finishUpload(id) {
  uploads = uploads.map((u) => (u.id === id ? { ...u, progress: 1, status: 'done' } : u));
  emit();
  setTimeout(() => removeUpload(id), 1500);
}

export function failUpload(id, message) {
  uploads = uploads.map((u) => (u.id === id ? { ...u, status: 'error', error: message } : u));
  emit();
  setTimeout(() => removeUpload(id), 4000);
}

export function removeUpload(id) {
  uploads = uploads.filter((u) => u.id !== id);
  emit();
}

// Runs a tracked upload: registers it in the store, streams progress into it
// via XHR, and settles it as done/error. Callers still get the same response
// shape `api.post` would have returned.
export async function trackedUpload(url, file, formData) {
  // Refused here, before the request opens. The server checks the same limit
  // twice more (Content-Length, then the arriving bytes) for callers that are
  // not this app.
  const tooLarge = fileTooLargeMessage(file);
  if (tooLarge) throw new Error(tooLarge);

  const id = startUpload(file.name, file.size);
  try {
    const data = await postWithProgress(url, formData, (fraction) =>
      updateUploadProgress(id, fraction)
    );
    finishUpload(id);
    return data;
  } catch (err) {
    failUpload(id, err.message);
    throw err;
  }
}
