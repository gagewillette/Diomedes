import { postWithProgress } from './api.js';

// Tracks in-flight file uploads so the UI can show a progress bar instead of
// letting the user click upload again while a large file is still going.
let uploads = [];
let nextId = 1;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(uploads);
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
