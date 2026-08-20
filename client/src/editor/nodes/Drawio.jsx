import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, Modal, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import { IconZoomScan } from '@tabler/icons-react';
import { DiagramLightbox, useZoomClickHandlers } from '../DiagramLightbox';

const DRAWIO_ORIGIN = 'https://embed.diagrams.net';

function DrawioView({ node, updateAttributes, editor, selected }) {
  const [open, setOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const iframeRef = useRef(null);
  const xmlRef = useRef(node.attrs.xml);
  const colorScheme = useComputedColorScheme('light');

  useEffect(() => {
    if (node.attrs.autoOpen && editor.isEditable) {
      updateAttributes({ autoOpen: false });
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        post({ action: 'load', xml: node.attrs.xml || '', autosave: 0 });
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
  }, [open, node.attrs.xml, updateAttributes]);

  const zoomHandlers = useZoomClickHandlers({
    editable: editor.isEditable,
    onZoom: () => setZoomOpen(true),
    onEdit: () => setOpen(true),
  });

  const src = `${DRAWIO_ORIGIN}/?embed=1&proto=json&spin=1&ui=${colorScheme === 'dark' ? 'dark' : 'atlas'}&saveAndExit=1&noSaveBtn=0&noExitBtn=0`;

  return (
    <NodeViewWrapper className={`gd-drawio ${selected ? 'is-selected' : ''}`} contentEditable={false}>
      {node.attrs.svg ? (
        <div className="gd-drawio-preview" {...zoomHandlers}>
          <img src={node.attrs.svg} alt="draw.io diagram" />
        </div>
      ) : (
        <div className="gd-excalidraw-empty" onDoubleClick={() => editor.isEditable && setOpen(true)}>
          <Text c="dimmed" size="sm">
            Empty draw.io diagram{editor.isEditable ? ' — double-click to edit' : ''}
          </Text>
        </div>
      )}
      <div className="gd-node-actions">
        {node.attrs.svg && (
          <Tooltip label="Open full screen">
            <ActionIcon
              size="sm"
              variant="light"
              aria-label="Open diagram full screen"
              onClick={() => setZoomOpen(true)}
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
      <DiagramLightbox
        opened={zoomOpen}
        onClose={() => setZoomOpen(false)}
        title="draw.io diagram"
        src={node.attrs.svg}
      />
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
      autoOpen: { default: false, rendered: false },
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
