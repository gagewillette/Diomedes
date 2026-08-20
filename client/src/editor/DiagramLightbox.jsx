import { useCallback, useEffect, useRef, useState } from 'react';
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
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const setViewSafe = useCallback((next) => {
    viewRef.current = next;
    setView(next);
  }, []);

  // scale so the diagram fills the viewport, then centre it
  const fit = useCallback(() => {
    const vp = viewportRef.current;
    const el = contentRef.current;
    if (!vp || !el) return;
    const prev = el.style.transform;
    el.style.transform = 'none';
    const cw = el.offsetWidth;
    const ch = el.offsetHeight;
    el.style.transform = prev;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (!cw || !ch || !vw || !vh) return;
    const s = clampScale(Math.min((vw * 0.94) / cw, (vh * 0.94) / ch));
    setViewSafe({ s, x: (vw - cw * s) / 2, y: (vh - ch * s) / 2 });
  }, [setViewSafe]);

  // zoom keeping the point under the cursor (or the viewport centre) fixed
  const zoomAt = useCallback((factor, px, py) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const cx = px == null ? rect.width / 2 : px - rect.left;
    const cy = py == null ? rect.height / 2 : py - rect.top;
    const v = viewRef.current;
    const s = clampScale(v.s * factor);
    const k = s / v.s;
    setViewSafe({ s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
  }, [setViewSafe]);

  // mount the diagram content
  useEffect(() => {
    if (!opened) return undefined;
    const el = contentRef.current;
    if (!el) return undefined;
    let cancelled = false;
    if (renderNode) {
      (async () => {
        try {
          const node = await renderNode();
          if (cancelled || !contentRef.current) return;
          contentRef.current.replaceChildren(node);
          pinSvgSize(contentRef.current);
          requestAnimationFrame(fit);
        } catch (err) {
          console.error('diagram lightbox render failed', err);
        }
      })();
    } else if (html != null) {
      el.innerHTML = html;
      pinSvgSize(el);
      requestAnimationFrame(fit);
    } else {
      requestAnimationFrame(fit);
    }
    return () => { cancelled = true; };
  }, [opened, html, renderNode, fit]);

  // wheel zoom needs a non-passive listener to be able to preventDefault
  useEffect(() => {
    const vp = viewportRef.current;
    if (!opened || !vp) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [opened, zoomAt]);

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
          ref={viewportRef}
          className="gd-lightbox-viewport"
          onPointerDown={onPointerDown}
          onDoubleClick={() => zoomAt(1.6)}
        >
          <div
            ref={contentRef}
            className="gd-lightbox-content"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
          >
            {src ? <img src={src} alt={title} draggable={false} onLoad={fit} /> : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Click opens the zoom viewer, double-click opens the editor (when editable).
 * A short delay lets the double-click win over the single click.
 */
export function useZoomClickHandlers({ editable, onZoom, onEdit }) {
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!editable) {
    return { onClick: onZoom, style: { cursor: 'zoom-in' } };
  }
  return {
    style: { cursor: 'zoom-in' },
    onClick: (e) => {
      if (e.detail > 1) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(onZoom, 220);
    },
    onDoubleClick: () => {
      clearTimeout(timer.current);
      onEdit?.();
    },
  };
}
