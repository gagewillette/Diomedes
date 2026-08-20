import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { ActionIcon, Text, Tooltip } from '@mantine/core';
import { IconDownload, IconEye, IconFileTypePdf, IconPresentation } from '@tabler/icons-react';

export const PDF_MIME = 'application/pdf';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const PPT_MIME = 'application/vnd.ms-powerpoint';

/** 'pdf' | 'pptx' | null — null means this is not a document we place in a bar. */
export function docKindFor(file) {
  const name = (file?.name || '').toLowerCase();
  const mime = file?.type || '';
  if (mime === PDF_MIME || name.endsWith('.pdf')) return 'pdf';
  if (mime === PPTX_MIME || mime === PPT_MIME || name.endsWith('.pptx') || name.endsWith('.ppt')) return 'pptx';
  return null;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function DocumentView({ node, selected }) {
  const { url, filename, size, kind } = node.attrs;
  const isPdf = kind === 'pdf';
  const Icon = isPdf ? IconFileTypePdf : IconPresentation;
  const downloadUrl = url ? `${url}${url.includes('?') ? '&' : '?'}download=1` : '';

  // Only PDFs are viewable. A new tab on the inline URL hands the file to
  // Chrome's built-in PDF viewer — no in-app renderer involved.
  const view = () => {
    if (!isPdf || !url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <NodeViewWrapper
      className={`gd-document ${selected ? 'is-selected' : ''}`}
      data-drag-handle
      contentEditable={false}
    >
      <Icon size={22} stroke={1.6} className="gd-document-icon" />
      <div className="gd-document-meta">
        <Text className="gd-document-name" size="sm" fw={500} truncate="end" title={filename}>
          {filename || 'Document'}
        </Text>
        <Text size="xs" c="dimmed">
          {[isPdf ? 'PDF' : 'PowerPoint', formatSize(size)].filter(Boolean).join(' · ')}
        </Text>
      </div>
      <div className="gd-document-actions">
        <Tooltip label="Download" withArrow>
          <ActionIcon
            component="a"
            href={downloadUrl}
            variant="subtle"
            color="gray"
            aria-label={`Download ${filename}`}
          >
            <IconDownload size={18} stroke={1.6} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={isPdf ? 'Open in a new tab' : 'PowerPoint files can only be downloaded'} withArrow>
          {/* span keeps the tooltip alive while the control is disabled */}
          <span>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={view}
              disabled={!isPdf}
              aria-label={isPdf ? `View ${filename}` : 'Not viewable'}
            >
              <IconEye size={18} stroke={1.6} />
            </ActionIcon>
          </span>
        </Tooltip>
      </div>
    </NodeViewWrapper>
  );
}

export const DocumentBlock = Node.create({
  name: 'documentBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      url: { default: '' },
      filename: { default: 'Document' },
      mime: { default: PDF_MIME },
      size: { default: 0 },
      kind: { default: 'pdf' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="document"]',
        getAttrs: (el) => ({
          attachmentId: el.getAttribute('data-attachment-id'),
          url: el.getAttribute('data-url') || '',
          filename: el.getAttribute('data-filename') || 'Document',
          mime: el.getAttribute('data-mime') || PDF_MIME,
          size: Number(el.getAttribute('data-size') || 0),
          kind: el.getAttribute('data-kind') === 'pptx' ? 'pptx' : 'pdf',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Same reason as the diagram nodes: HTMLAttributes carries the global block
    // id, and an attachment that loses its id on save stops being addressable.
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'document',
        'data-attachment-id': node.attrs.attachmentId,
        'data-url': node.attrs.url,
        'data-filename': node.attrs.filename,
        'data-mime': node.attrs.mime,
        'data-size': String(node.attrs.size || 0),
        'data-kind': node.attrs.kind,
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocumentView);
  },
});
