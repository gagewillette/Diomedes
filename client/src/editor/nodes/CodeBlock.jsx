// The code block as a real surface: a language picker, a copy button, a
// soft-wrap toggle, line numbers and a problem count.
//
// Two constraints shape everything here.
//
// **The contentDOM stays `<pre><code>`.** `NodeViewContent` renders the `code`
// element and ProseMirror owns everything inside it. The chrome is siblings of
// that element, marked `contentEditable={false}`, so text editing, `blockId`
// and the drag handle in ../blockDrag.js behave exactly as they did when this
// was a bare `<pre>`. Anything that puts a widget *inside* the content DOM
// would become typeable — and, worse, would become document text on copy.
//
// **Nothing here writes to the document except the language attribute.** That
// one write is a real edit and should be: it is what markdown export puts back
// in the fence info string. The wrap toggle is per-device and lives in
// localStorage; diagnostics are decorations owned by ../code/lintPlugin.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { ActionIcon, Badge, Group, Select, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconTextWrap, IconTextWrapDisabled } from '@tabler/icons-react';
import {
  DIAGRAM_LANGUAGES, ensureLanguage, languageLabel, languageOptions, lowlight,
  resolveDiagramLanguage, resolveLanguage,
} from '../code/languages.js';
import { HIGHLIGHT_BYTE_CAP, SKIP_MESSAGES, byteLength, lintSkipReason } from '../code/lintState.js';
import { lintPluginKey, reportVisibility } from '../code/lintPlugin.js';
import { isDrawioXml } from '../../lib/diagramBlocks.js';

// Soft wrap is a property of this reader's screen, not of the document, so it
// is stored per device and keyed on the block id. Writing it into the doc would
// sync one person's narrow laptop to everybody else's editor.
const WRAP_KEY = (blockId) => `gd.codewrap.${blockId}`;

const readWrap = (blockId) => {
  if (!blockId) return false;
  try {
    return localStorage.getItem(WRAP_KEY(blockId)) === '1';
  } catch {
    // Private mode, or storage disabled. Not being able to remember a wrap
    // preference is not a reason to fail to render the block.
    return false;
  }
};

const writeWrap = (blockId, on) => {
  if (!blockId) return;
  try {
    if (on) localStorage.setItem(WRAP_KEY(blockId), '1');
    else localStorage.removeItem(WRAP_KEY(blockId));
  } catch { /* see readWrap */ }
};

/** Diagnostics the lint plugin currently holds for this node, in order. */
function problemsFor(editor, getPos, node) {
  const set = editor && lintPluginKey.getState(editor.state);
  if (!set || typeof getPos !== 'function') return [];
  let pos;
  try {
    pos = getPos();
  } catch {
    return [];
  }
  if (typeof pos !== 'number') return [];
  return set.find(pos, pos + node.nodeSize).map((d) => ({
    from: d.from,
    message: d.type?.attrs?.title || '',
    severity: d.type?.attrs?.class?.includes('warn') ? 'warning' : 'error',
  }));
}

function CodeBlockView({ node, updateAttributes, editor, getPos, extension }) {
  const { language, blockId } = node.attrs;
  const settings = extension.options.codeIntelligence;
  const [wrap, setWrap] = useState(() => readWrap(blockId));
  const [copied, setCopied] = useState(false);
  const [, forceRender] = useState(0);
  const wrapperRef = useRef(null);

  const code = node.textContent;
  const bytes = byteLength(code);
  const resolved = resolveLanguage(language);
  const lineCount = code.split('\n').length;

  // Fetch the grammar the first time this language is on screen, then nudge one
  // repaint so the block that triggered the load actually gets coloured. The
  // transaction carries no document change and never enters history — it exists
  // only to make ProseMirror re-run the decoration pass for this node.
  useEffect(() => {
    if (!settings.highlighting || !resolved || bytes > HIGHLIGHT_BYTE_CAP) return;
    if (lowlight.registered(resolved)) return;
    let cancelled = false;
    ensureLanguage(resolved).then((id) => {
      if (cancelled || !id || !editor?.view) return;
      const tr = editor.view.state.tr.setMeta('codeLangLoaded', blockId || id);
      tr.setMeta('addToHistory', false);
      editor.view.dispatch(tr);
    });
    return () => { cancelled = true; };
  }, [resolved, settings.highlighting, bytes, blockId, editor]);

  // Offscreen blocks are never parsed. Without this a page with forty code
  // blocks would run forty parsers on load, for thirty-eight blocks nobody has
  // scrolled to yet.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || !blockId || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => reportVisibility(editor, blockId, entry.isIntersecting),
      // Roughly two viewports of lead-in, so a block is already checked by the
      // time it is scrolled to rather than lighting up under the reader's eyes.
      { rootMargin: '100% 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [blockId, editor]);

  // Diagnostics live in plugin state, which React knows nothing about. One
  // subscription per block, and only while there is something to show.
  useEffect(() => {
    if (!editor) return undefined;
    const onTransaction = () => forceRender((n) => n + 1);
    editor.on('transaction', onTransaction);
    return () => editor.off('transaction', onTransaction);
  }, [editor]);

  const problems = settings.linting ? problemsFor(editor, getPos, node) : [];
  const skip = lintSkipReason({
    enabled: settings.linting,
    language,
    bytes,
    maxBytes: settings.maxBytes,
  });
  const skipMessage = SKIP_MESSAGES[skip] ?? null;

  const options = useMemo(() => languageOptions(), []);

  /**
   * Picking a language.
   *
   * Choosing mermaid or draw.io does not set an attribute — it replaces the
   * node with the diagram node those fences already become on markdown import
   * (see ../../lib/diagramBlocks.js). Routing both paths through the same
   * conversion is what stops "a mermaid code block" from existing as a third,
   * half-working state.
   */
  const chooseLanguage = (value) => {
    if (!value) {
      updateAttributes({ language: null });
      return;
    }
    const diagram = resolveDiagramLanguage(value);
    if (diagram && typeof getPos === 'function') {
      const type = DIAGRAM_LANGUAGES[diagram].node;
      const attrs = diagram === 'mermaid'
        ? { blockId, code }
        // A block that is not mxGraph XML still becomes a draw.io node — an
        // empty canvas is what the person asked for by picking draw.io.
        : { blockId, xml: isDrawioXml(code) ? code.trim() : '', svg: '' };
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          const pos = getPos();
          tr.replaceWith(pos, pos + node.nodeSize, editor.schema.nodes[type].create(attrs));
          return true;
        })
        .run();
      return;
    }
    updateAttributes({ language: value });
  };

  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {}
    );
  };

  const toggleWrap = () => {
    setWrap((on) => {
      writeWrap(blockId, !on);
      return !on;
    });
  };

  // Scroll to the first problem. The decoration already carries the document
  // position, so this is a selection move, not a search.
  const goToFirstProblem = () => {
    const first = problems[0];
    if (!first || !editor) return;
    editor.chain().focus().setTextSelection(first.from).scrollIntoView().run();
  };

  const errors = problems.filter((p) => p.severity === 'error').length;

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={[
        'gd-code-block',
        wrap ? 'is-wrapped' : '',
        editor.isEditable ? '' : 'is-readonly',
        // Grammars already registered earlier in this session keep emitting
        // hljs spans, so switching highlighting off has to neutralise the
        // colours too — otherwise the toggle would only take effect on the
        // next reload, which is exactly what it promises not to need.
        settings.highlighting ? '' : 'is-plain',
      ].filter(Boolean).join(' ')}
    >
      <div className="gd-code-header" contentEditable={false}>
        {editor.isEditable ? (
          <Select
            data={options}
            value={resolved || resolveDiagramLanguage(language) || null}
            onChange={chooseLanguage}
            placeholder="Plain text"
            searchable
            clearable
            size="xs"
            variant="unstyled"
            comboboxProps={{ withinPortal: true, width: 220 }}
            className="gd-code-lang"
            aria-label="Code language"
          />
        ) : (
          // A reader gets the name, not a control they cannot use.
          <Text size="xs" c="dimmed" className="gd-code-lang-label">
            {language ? languageLabel(language) : ''}
          </Text>
        )}

        <Group gap={4} wrap="nowrap">
          {skipMessage && (
            <Text size="xs" c="dimmed">{skipMessage}</Text>
          )}
          {problems.length > 0 && (
            <Badge
              size="xs"
              variant="light"
              color={errors ? 'red' : 'yellow'}
              style={{ cursor: 'pointer' }}
              onClick={goToFirstProblem}
              title={problems.map((p) => p.message).join('\n')}
            >
              {problems.length} problem{problems.length === 1 ? '' : 's'}
            </Badge>
          )}
          <Tooltip label={wrap ? 'No wrapping' : 'Soft wrap'} withinPortal>
            <ActionIcon variant="subtle" size="sm" color="gray" onClick={toggleWrap} aria-label="Toggle soft wrap">
              {wrap ? <IconTextWrapDisabled size={14} /> : <IconTextWrap size={14} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label={copied ? 'Copied' : 'Copy'} withinPortal>
            <ActionIcon variant="subtle" size="sm" color={copied ? 'green' : 'gray'} onClick={copy} aria-label="Copy code">
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </div>

      <pre className="gd-code-pre">
        {/* The gutter is a sibling of the content DOM, not a child of it: a
            line number inside <code> would be typeable, selectable and would
            come along on copy. */}
        <span className="gd-code-gutter" contentEditable={false} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </span>
        <NodeViewContent as="code" className={resolved ? `language-${resolved}` : undefined} />
      </pre>
    </NodeViewWrapper>
  );
}

/**
 * The extension. `lowlight` is the lazily-populated instance from
 * ../code/languages.js — a grammar it has never been given simply renders
 * uncoloured, which is the correct behaviour both before a chunk lands and
 * for a language we do not carry at all.
 */
export const CodeBlock = CodeBlockLowlight.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      lowlight,
      // Overwritten from Editor.jsx with the live workspace settings.
      codeIntelligence: { highlighting: true, linting: false, maxBytes: 100_000 },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
