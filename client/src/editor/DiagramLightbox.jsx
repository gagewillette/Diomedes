import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActionIcon, Group, Modal, Text, Tooltip } from '@mantine/core';
import { IconMaximize, IconX, IconZoomIn, IconZoomOut } from '@tabler/icons-react';

const MIN_SCALE = 0.1;
const MAX_SCALE = 16;
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// renderers (mermaid especially) size their svg responsively, which has no meaning
// inside the shrink-to-fit viewer — pin it to its intrinsic size instead
function pinSvgSize(root) {
  const svg = root?.tagName?.toLowerCase() === 'svg' ? root : root?.querySelector?.('svg');
  if (!svg) return;
  const box = svg.viewBox?.baseVal;
  svg.style.maxWidth = 'none';
  if (box?.width && box?.height) {
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    svg.style.width = `${box.width}px`;
    svg.style.height = `${box.height}px`;
  }
}

/**
 * Full-screen viewer for a diagram (draw.io / excalidraw / mermaid) with wheel zoom,
 * drag to pan and zoom buttons. Content is supplied one of three ways:
 *   src        - an image url / data uri (draw.io preview svg)
 *   html       - an svg markup string (mermaid)
 *   renderNode - async () => Node, mounted into the viewer (excalidraw export)
 */
export function DiagramLightbox({ opened, onClose, title = 'Diagram', src, html, renderNode }) {
  // the modal mounts its body a tick after `opened` flips, so plain refs are
  // still null when the effects below first run — and a ref changing never
  // re-runs them. Callback refs land in state, which does.
  const [viewportEl, setViewportEl] = useState(null);
  const [contentEl, setContentEl] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const setViewSafe = useCallback((next) => {
    viewRef.current = next;
    setView(next);
  }, []);

  // scale so the diagram fills the viewport, then centre it
  const fit = useCallback(() => {
    const vp = viewportEl;
    const el = contentEl;
    if (!vp || !el) return false;
    const prev = el.style.transform;
    el.style.transform = 'none';
    const cw = el.offsetWidth;
    const ch = el.offsetHeight;
    el.style.transform = prev;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (!cw || !ch || !vw || !vh) return false;
    const s = clampScale(Math.min((vw * 0.94) / cw, (vh * 0.94) / ch));
    setViewSafe({ s, x: (vw - cw * s) / 2, y: (vh - ch * s) / 2 });
    return true;
  }, [setViewSafe, viewportEl, contentEl]);

  // the modal animates in, so the first measurement can land on a viewport that
  // has no size yet — keep asking for a frame until one of them measures
  const requestFit = useCallback(() => {
    let frames = 0;
    const attempt = () => {
      if (fit() || ++frames > 30) return;
      requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  }, [fit]);

  // zoom keeping the point under the cursor (or the viewport centre) fixed
  const zoomAt = useCallback((factor, px, py) => {
    const vp = viewportEl;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const cx = px == null ? rect.width / 2 : px - rect.left;
    const cy = py == null ? rect.height / 2 : py - rect.top;
    const v = viewRef.current;
    const s = clampScale(v.s * factor);
    const k = s / v.s;
    setViewSafe({ s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
  }, [setViewSafe, viewportEl]);

  // mount the diagram content
  useEffect(() => {
    if (!opened || !contentEl) return undefined;
    let cancelled = false;
    if (renderNode) {
      (async () => {
        try {
          const node = await renderNode();
          if (cancelled) return;
          contentEl.replaceChildren(node);
          pinSvgSize(contentEl);
          requestFit();
        } catch (err) {
          console.error('diagram lightbox render failed', err);
        }
      })();
    } else if (html != null) {
      contentEl.innerHTML = html;
      pinSvgSize(contentEl);
      requestFit();
    } else {
      requestFit();
    }
    return () => { cancelled = true; };
  }, [opened, contentEl, html, renderNode, requestFit]);

  // wheel zoom needs a non-passive listener to be able to preventDefault
  useEffect(() => {
    const vp = viewportEl;
    if (!opened || !vp) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [opened, viewportEl, zoomAt]);

  useEffect(() => {
    if (!opened) return undefined;
    const onResize = () => fit();
    const onKey = (e) => {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.25); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(0.8); }
      else if (e.key === '0') { e.preventDefault(); fit(); }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
    };
  }, [opened, fit, zoomAt]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const start = { px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
    const move = (ev) => {
      setViewSafe({
        s: viewRef.current.s,
        x: start.x + (ev.clientX - start.px),
        y: start.y + (ev.clientY - start.py),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      padding={0}
      withCloseButton={false}
      transitionProps={{ duration: 120 }}
      styles={{ body: { height: '100vh', padding: 0 } }}
    >
      <div className="gd-lightbox">
        <div className="gd-lightbox-bar">
          <Text size="sm" fw={600} className="gd-lightbox-title">{title}</Text>
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed" w={48} ta="right">{Math.round(view.s * 100)}%</Text>
            <Tooltip label="Zoom out (-)">
              <ActionIcon variant="subtle" onClick={() => zoomAt(0.8)} aria-label="Zoom out"><IconZoomOut size={18} /></ActionIcon>
            </Tooltip>
            <Tooltip label="Zoom in (+)">
              <ActionIcon variant="subtle" onClick={() => zoomAt(1.25)} aria-label="Zoom in"><IconZoomIn size={18} /></ActionIcon>
            </Tooltip>
            <Tooltip label="Fit to screen (0)">
              <ActionIcon variant="subtle" onClick={fit} aria-label="Fit to screen"><IconMaximize size={18} /></ActionIcon>
            </Tooltip>
            <Tooltip label="Close (Esc)">
              <ActionIcon variant="subtle" onClick={onClose} aria-label="Close"><IconX size={18} /></ActionIcon>
            </Tooltip>
          </Group>
        </div>
        <div
          ref={setViewportEl}
          className="gd-lightbox-viewport"
          onPointerDown={onPointerDown}
          onDoubleClick={() => zoomAt(1.6)}
        >
          <div
            ref={setContentEl}
            className="gd-lightbox-content"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
          >
            {src ? <img src={src} alt={title} draggable={false} onLoad={requestFit} /> : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------
 * The viewer lives once, at the top of the app, driven by this store.
 *
 * It used to be rendered by each diagram node view, opened from that view's
 * own state. Clicking a diagram makes ProseMirror re-draw the node, which
 * throws that state away — the click "did nothing". Keeping it outside React's
 * editor tree makes opening the viewer independent of the node's lifetime.
 * ---------------------------------------------------------------------- */
let zoomTarget = null;
const zoomListeners = new Set();

function emitZoom() {
  for (const listener of zoomListeners) listener();
}

/** open the viewer on `{ title, src | html | renderNode }` */
export function openDiagramLightbox(target) {
  zoomTarget = target;
  emitZoom();
}

export function closeDiagramLightbox() {
  zoomTarget = null;
  emitZoom();
}

function subscribeZoom(listener) {
  zoomListeners.add(listener);
  return () => zoomListeners.delete(listener);
}

const getZoomTarget = () => zoomTarget;

/** mount once, above the editor, so a diagram can outlive its node view */
export function DiagramLightboxHost() {
  const target = useSyncExternalStore(subscribeZoom, getZoomTarget, getZoomTarget);
  return (
    <DiagramLightbox
      // a fresh viewer per diagram: no stale pan/zoom or leftover svg
      key={target?.key ?? 'none'}
      opened={Boolean(target)}
      onClose={closeDiagramLightbox}
      title={target?.title}
      src={target?.src}
      html={target?.html}
      renderNode={target?.renderNode}
    />
  );
}

/**
 * Click opens the zoom viewer, double-click opens the editor (when editable).
 * A short delay lets the double-click win over the single click. The timer is
 * module-level on purpose — a node view re-drawn by the click must not cancel
 * the zoom it just asked for.
 *
 * Everything hangs off mousedown, in the capture phase: pressing on a diagram
 * makes ProseMirror select the node and rebuild its DOM, so by the time a
 * bubbled mousedown (let alone the click that would follow) reaches React, the
 * element it was aimed at is gone and the handler never runs.
 */
let clickTimer = null;

export function useZoomClickHandlers({ editable, onZoom, onEdit }) {
  const zoom = () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(onZoom, editable ? 220 : 0);
  };
  return {
    style: { cursor: 'zoom-in' },
    onMouseDownCapture: (e) => {
      if (e.button !== 0) return;
      if (e.detail > 1) {
        clearTimeout(clickTimer);
        if (editable) onEdit?.();
        return;
      }
      zoom();
    },
  };
}
