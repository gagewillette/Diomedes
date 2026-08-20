// Turn draw.io (mxGraph) XML into a preview image, without opening the editor.
//
// A diagram drawn in the UI arrives with both its XML and an SVG preview,
// exported by the embed when the user hits save. A diagram pushed in over the
// MCP wire has only the XML — markdown has no room for a picture. So we render
// it here the same way the editor would: load the XML into an offscreen
// embed.diagrams.net frame and ask it to export `xmlsvg` (an SVG with the
// source XML embedded in it, which is exactly what the editor stores).
//
// One frame is reused for every diagram and the results are memoised per XML
// string, so a page full of diagrams costs one frame load.

export const DRAWIO_ORIGIN = 'https://embed.diagrams.net';

const RENDER_SRC = `${DRAWIO_ORIGIN}/?embed=1&proto=json&spin=0&noSaveBtn=1&noExitBtn=1&stealth=1&math=0`;
const RENDER_TIMEOUT = 30000;

const cache = new Map();
let frame = null; // { el, ready: Promise<void> }
let chain = Promise.resolve();

function ensureFrame() {
  if (frame) return frame;

  const el = document.createElement('iframe');
  el.title = 'draw.io renderer';
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1;
  // Offscreen rather than hidden: draw.io measures text to lay the graph out,
  // so the frame needs a real size and a live layout.
  Object.assign(el.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: '1200px',
    height: '900px',
    border: 'none',
    opacity: '0',
    pointerEvents: 'none',
  });

  const ready = new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.origin !== DRAWIO_ORIGIN || event.source !== el.contentWindow) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.event === 'init') {
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('draw.io renderer did not start (is embed.diagrams.net reachable?)'));
    }, RENDER_TIMEOUT);
    window.addEventListener('message', onMessage);
  });

  el.src = RENDER_SRC;
  document.body.appendChild(el);

  frame = { el, ready };
  // A frame that never started is worth retrying on the next diagram.
  ready.catch(() => {
    if (frame?.el === el) {
      el.remove();
      frame = null;
    }
  });
  return frame;
}

function exportOnce(xml) {
  const { el, ready } = ensureFrame();
  return ready.then(
    () =>
      new Promise((resolve, reject) => {
        const post = (data) => el.contentWindow?.postMessage(JSON.stringify(data), DRAWIO_ORIGIN);

        const done = (fn) => (arg) => {
          window.removeEventListener('message', onMessage);
          clearTimeout(timer);
          fn(arg);
        };
        const finish = done(resolve);
        const fail = done(reject);

        const onMessage = (event) => {
          if (event.origin !== DRAWIO_ORIGIN || event.source !== el.contentWindow) return;
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          if (msg.event === 'export') {
            if (msg.data) finish(msg.data);
            else fail(new Error('draw.io returned an empty export'));
          } else if (msg.event === 'error') {
            fail(new Error(msg.message || 'draw.io could not render this XML'));
          }
        };

        const timer = setTimeout(
          () => fail(new Error('draw.io took too long to render this diagram')),
          RENDER_TIMEOUT
        );
        window.addEventListener('message', onMessage);

        post({ action: 'load', xml, autosave: 0 });
        post({ action: 'export', format: 'xmlsvg' });
      })
  );
}

/**
 * Render mxGraph XML to an SVG data URI.
 * Calls are serialised — the renderer frame holds one diagram at a time.
 */
export function renderDrawioXml(xml) {
  const key = String(xml || '');
  if (!key.trim()) return Promise.reject(new Error('empty diagram'));
  if (cache.has(key)) return Promise.resolve(cache.get(key));

  const job = () =>
    exportOnce(key).then((data) => {
      cache.set(key, data);
      return data;
    });

  const result = chain.then(job, job);
  chain = result.catch(() => {});
  return result;
}
