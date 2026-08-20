import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, Loader, Modal, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import { IconZoomScan } from '@tabler/icons-react';
import { openDiagramLightbox, useZoomClickHandlers } from '../DiagramLightbox';
import { DRAWIO_ORIGIN, renderDrawioXml } from '../drawioRender.js';
import { claimDiagramEditor } from './diagramAutoOpen.js';

function DrawioView({ node, updateAttributes, editor, selected }) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState('');
  const [renderError, setRenderError] = useState(null);
  const iframeRef = useRef(null);
  const xmlRef = useRef(node.attrs.xml);
  const colorScheme = useComputedColorScheme('light');

  // A diagram the reader just inserted opens straight into its editor. The
  // request is claimed once, from memory — never from the document, which would
  // re-open the editor on every later mount. See diagramAutoOpen.js.
  useEffect(() => {
    if (editor.isEditable && claimDiagramEditor('drawioDiagram')) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A diagram pushed in over the API — the MCP server, say — carries only its
  // mxGraph XML; markdown has no room for a picture. Draw the preview here the
  // way the editor would have, and cache it back onto the node so later readers
  // (including anyone without write access) get it for free.
  const { xml, svg } = node.attrs;
  useEffect(() => {
    if (!xml || svg) {
      setRendered('');
      setRenderError(null);
      return undefined;
    }
    let cancelled = false;
    setRenderError(null);
    renderDrawioXml(xml).then(
      (data) => {
        if (cancelled) return;
        setRendered(data);
        if (editor.isEditable) updateAttributes({ svg: data });
      },
      (err) => {
        if (!cancelled) setRenderError(String(err?.message || err));
      }
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml, svg, editor.isEditable]);

  const preview = svg || rendered;

  const close = () => {
    setOpen(false);
    setTimeout(() => editor.commands.focus(), 0);
  };

  useEffect(() => {
    if (!open) return;
    const onMessage = (event) => {
      if (event.origin !== DRAWIO_ORIGIN || event.source !== iframeRef.current?.contentWindow) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const post = (data) => iframeRef.current?.contentWindow?.postMessage(JSON.stringify(data), DRAWIO_ORIGIN);
      if (msg.event === 'init') {
        post({ action: 'load', xml: xml || '', autosave: 0 });
      } else if (msg.event === 'save') {
        xmlRef.current = msg.xml;
        post({ action: 'export', format: 'xmlsvg' }); // svg with the xml embedded, used as preview
      } else if (msg.event === 'export') {
        updateAttributes({ xml: msg.xml || xmlRef.current, svg: msg.data });
        close();
      } else if (msg.event === 'exit') {
        close();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, xml, updateAttributes]);

  const openZoom = () =>
    openDiagramLightbox({ key: `drawio-${preview?.slice(0, 64)}`, title: 'draw.io diagram', src: preview });

  const zoomHandlers = useZoomClickHandlers({
    editable: editor.isEditable,
    onZoom: openZoom,
    onEdit: () => setOpen(true),
  });

  const src = `${DRAWIO_ORIGIN}/?embed=1&proto=json&spin=1&ui=${colorScheme === 'dark' ? 'dark' : 'atlas'}&saveAndExit=1&noSaveBtn=0&noExitBtn=0`;

  return (
    <NodeViewWrapper className={`gd-drawio ${selected ? 'is-selected' : ''}`} contentEditable={false}>
      {preview ? (
        <div className="gd-drawio-preview" {...zoomHandlers}>
          <img src={preview} alt="draw.io diagram" />
        </div>
      ) : renderError ? (
        <div className="gd-drawio-error" onDoubleClick={() => editor.isEditable && setOpen(true)}>
          <Text c="red" size="sm">
            Could not render this draw.io diagram: {renderError}
          </Text>
          <pre>{xml}</pre>
        </div>
      ) : xml ? (
        <div className="gd-drawio-loading">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Rendering draw.io diagram…
          </Text>
        </div>
      ) : (
        <div className="gd-excalidraw-empty" onDoubleClick={() => editor.isEditable && setOpen(true)}>
          <Text c="dimmed" size="sm">
            Empty draw.io diagram{editor.isEditable ? ' — double-click to edit' : ''}
          </Text>
        </div>
      )}
      <div className="gd-node-actions">
        {preview && (
          <Tooltip label="Open full screen">
            <ActionIcon
              size="sm"
              variant="light"
              aria-label="Open diagram full screen"
              onClick={openZoom}
            >
              <IconZoomScan size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {editor.isEditable && (
          <Button size="compact-xs" variant="light" onClick={() => setOpen(true)}>
            Edit diagram
          </Button>
        )}
      </div>
      <Modal
        opened={open}
        onClose={close}
        fullScreen
        padding={0}
        withCloseButton={false}
        styles={{ body: { height: '100vh' } }}
      >
        {open && (
          <iframe
            ref={iframeRef}
            src={src}
            title="draw.io editor"
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        )}
      </Modal>
    </NodeViewWrapper>
  );
}

export const DrawioBlock = Node.create({
  name: 'drawioDiagram',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      xml: { default: '' },
      svg: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="drawio"]',
        getAttrs: (el) => ({ xml: el.getAttribute('data-xml') || '', svg: el.getAttribute('data-svg') || '' }),
      },
    ];
  },
  renderHTML({ node }) {
    return ['div', { 'data-type': 'drawio', 'data-xml': node.attrs.xml, 'data-svg': node.attrs.svg }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DrawioView);
  },
});
