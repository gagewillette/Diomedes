// A DOM for tests that need a real editor.
//
// Most of this codebase's tests deliberately avoid one: the logic is pulled out
// into pure modules and exercised against a bare ProseMirror schema. The
// markdown round trip cannot be tested that way, because it runs through
// markdown-it, an HTML string, and ProseMirror's DOM parser — the DOM *is* the
// thing under test.
//
// Import this module before anything that touches `document`; ES modules are
// evaluated in import order, so the globals are in place by the time TipTap is
// loaded.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

for (const key of [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'DocumentFragment',
  'Node', 'NodeFilter', 'Range', 'DOMParser', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'CSS',
]) {
  if (globalThis[key] === undefined) {
    globalThis[key] = typeof dom.window[key] === 'function' && !/^[A-Z]/.test(key)
      ? dom.window[key].bind(dom.window)
      : dom.window[key];
  }
}

export { dom };
