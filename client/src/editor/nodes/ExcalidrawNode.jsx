import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Button, Modal, Group, Loader, Center, Text } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';

const ExcalidrawCanvas = lazy(() =>
  import('@excalidraw/excalidraw').then((m) => ({
    default: function Canvas({ initialData, onReady, theme }) {
      const Excalidraw = m.Excalidraw;
      return (
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={(api) => onReady(api)}
          theme={theme}
        />
      );
    },
  }))
);

function ExcalidrawView({ node, updateAttributes, editor, selected }) {
  const [open, setOpen] = useState(false);
  const previewRef = useRef(null);
  const apiRef = useRef(null);
  const colorScheme = useComputedColorScheme('light');
  const data = node.attrs.data || { elements: [], appState: {}, files: {} };
  const hasContent = (data.elements || []).length > 0;

  useEffect(() => {
    if (node.attrs.autoOpen && editor.isEditable) {
      updateAttributes({ autoOpen: false });
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!hasContent || !previewRef.current) return;
    (async () => {
      const { exportToSvg } = await import('@excalidraw/excalidraw');
      try {
        const svg = await exportToSvg({
          elements: data.elements,
          appState: { ...data.appState, exportBackground: true, exportWithDarkMode: colorScheme === 'dark' },
          files: data.files || {},
        });
        if (cancelled || !previewRef.current) return;
        svg.style.maxWidth = '100%';
        svg.style.height = 'auto';
        previewRef.current.replaceChildren(svg);
      } catch (err) {
        console.error('excalidraw preview failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [node.attrs.data, colorScheme]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setOpen(false);
    // give focus back to the editor so slash commands keep working
    setTimeout(() => editor.commands.focus(), 0);
  };

  const save = () => {
    const api = apiRef.current;
    if (api) {
      const appState = api.getAppState();
      updateAttributes({
        data: {
          elements: api.getSceneElements(),
          appState: { viewBackgroundColor: appState.viewBackgroundColor },
          files: api.getFiles(),
        },
      });
    }
    close();
  };

  return (
    <NodeViewWrapper className={`gd-excalidraw ${selected ? 'is-selected' : ''}`} contentEditable={false}>
      {hasContent ? (
        <div
          ref={previewRef}
          className="gd-excalidraw-preview"
          onDoubleClick={() => editor.isEditable && setOpen(true)}
        />
      ) : (
        <div className="gd-excalidraw-empty" onDoubleClick={() => editor.isEditable && setOpen(true)}>
          <Text c="dimmed" size="sm">Empty drawing{editor.isEditable ? ' — double-click to draw' : ''}</Text>
        </div>
      )}
      {editor.isEditable && (
        <Button size="compact-xs" variant="light" className="gd-node-edit-btn" onClick={() => setOpen(true)}>
          Edit drawing
        </Button>
      )}
      <Modal
        opened={open}
        onClose={save}
        fullScreen
        title={
          <Group>
            <Text fw={600}>Excalidraw</Text>
            <Button size="compact-sm" onClick={save}>Save & close</Button>
            <Button size="compact-sm" variant="subtle" onClick={close}>Discard changes</Button>
          </Group>
        }
      >
        <div style={{ height: 'calc(100vh - 80px)' }}>
          {open && (
            <Suspense fallback={<Center h="100%"><Loader /></Center>}>
              <ExcalidrawCanvas
                theme={colorScheme === 'dark' ? 'dark' : 'light'}
                initialData={{
                  elements: data.elements || [],
                  appState: { viewBackgroundColor: data.appState?.viewBackgroundColor || '#ffffff' },
                  files: data.files || {},
                }}
                onReady={(api) => { apiRef.current = api; }}
              />
            </Suspense>
          )}
        </div>
      </Modal>
    </NodeViewWrapper>
  );
}

export const ExcalidrawBlock = Node.create({
  name: 'excalidraw',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      data: { default: { elements: [], appState: {}, files: {} } },
      autoOpen: { default: false, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="excalidraw"]',
        getAttrs: (el) => {
          try {
            return { data: JSON.parse(el.getAttribute('data-scene') || '{}') };
          } catch {
            return { data: { elements: [], appState: {}, files: {} } };
          }
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['div', { 'data-type': 'excalidraw', 'data-scene': JSON.stringify(node.attrs.data) }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ExcalidrawView);
  },
});
