import { useCallback, useEffect, useState } from 'react';
import { getMarkRange } from '@tiptap/core';
import {
  Alert, Button, Group, Modal, Stack, Text, TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconExternalLink, IconLinkOff } from '@tabler/icons-react';
import { normalizeUrl, isValidUrl, isExternalUrl, linkHost } from './linkUrl.js';

/**
 * What the dialog should start with, given where the caret is.
 *
 * With the caret merely resting inside an existing link the whole link is the
 * subject — that is what someone means by "edit this link", and it is the range
 * the new display text has to replace. Otherwise the selection is the subject,
 * which may be empty: linking from a bare caret is how you insert a link whose
 * text you are about to type.
 */
function readSelection(editor) {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  const linkType = state.schema.marks.link;
  const range = linkType ? getMarkRange(state.doc.resolve(from), linkType) : null;

  // A selection that reaches past the link is an ordinary selection: the person
  // is choosing the range themselves and we should not widen it behind them.
  const useLinkRange = range && (empty || (from >= range.from && to <= range.to));
  const span = useLinkRange ? range : { from, to };

  return {
    from: span.from,
    to: span.to,
    text: state.doc.textBetween(span.from, span.to, ' ', ' '),
    href: editor.getAttributes('link').href || '',
    hadLink: Boolean(useLinkRange),
  };
}

function LinkDialog({ opened, seed, onClose, onApply, onRemove }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!opened || !seed) return;
    setText(seed.text);
    setUrl(seed.href);
    setTouched(false);
  }, [opened, seed]);

  const href = normalizeUrl(url);
  const valid = isValidUrl(url);
  const host = linkHost(url);
  const external = isExternalUrl(url);
  const error = touched && url.trim() && !valid
    ? 'That does not look like a web address. Try https://example.com'
    : null;

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    onApply({ text, href });
  };

  // A link with nowhere to open is not worth testing, so the button says so
  // rather than opening a blank tab.
  const test = () => {
    if (!valid) {
      setTouched(true);
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  return (
    <Modal opened={opened} onClose={onClose} title={seed?.hadLink ? 'Edit link' : 'Add link'} size="md" centered>
      <Stack gap="sm">
        <TextInput
          label="Text to display"
          placeholder="The words that appear on the page"
          description="Leave empty to show the address itself."
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          data-autofocus={seed?.text ? undefined : true}
        />
        <TextInput
          label="Link to"
          placeholder="https://example.com"
          value={url}
          error={error}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          data-autofocus={seed?.text ? true : undefined}
        />

        {external && valid && (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
            <Text size="xs">
              This opens <b>{host}</b> in a new tab. Only link to sites you trust — anyone who can
              read this page can click it, and a link's text can say anything at all.
            </Text>
          </Alert>
        )}

        <Group justify="space-between" mt="xs">
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconExternalLink size={14} />}
              onClick={test}
              disabled={!valid}
              title="Open this link in a new tab to check it"
            >
              Test link
            </Button>
            {seed?.hadLink && (
              <Button
                variant="subtle"
                color="red"
                size="xs"
                leftSection={<IconLinkOff size={14} />}
                onClick={onRemove}
              >
                Remove link
              </Button>
            )}
          </Group>
          <Group gap="xs">
            <Button variant="subtle" size="xs" onClick={onClose}>Cancel</Button>
            <Button size="xs" onClick={submit} disabled={!valid}>
              {seed?.hadLink ? 'Save' : 'Add link'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * The link dialog, wired to an editor.
 *
 * Lives above the bubble toolbar rather than inside it: opening the modal moves
 * focus out of the editor, the selection collapses, and the toolbar unmounts —
 * taking any dialog rendered within it along. The range captured at open time
 * is what gets edited, so losing the live selection costs nothing.
 */
export function useLinkDialog(editor) {
  const [seed, setSeed] = useState(null);

  const open = useCallback(() => {
    if (!editor) return;
    setSeed(readSelection(editor));
  }, [editor]);

  const close = useCallback(() => setSeed(null), []);

  const apply = useCallback(({ text, href }) => {
    if (!editor || !seed) return;
    const label = text.trim() || href;
    const { from, to } = seed;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from, to },
        [{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }],
        // Without this the caret lands back at `from` and the next keystroke
        // types into the middle of the link that was just made.
        { updateSelection: true }
      )
      // The mark is inclusive at its right edge, so whatever gets typed next
      // would join the link. Nobody means that.
      .unsetMark('link')
      .run();
    setSeed(null);
  }, [editor, seed]);

  const remove = useCallback(() => {
    if (!editor || !seed) return;
    editor.chain().focus().setTextSelection({ from: seed.from, to: seed.to }).unsetLink().run();
    setSeed(null);
  }, [editor, seed]);

  const element = (
    <LinkDialog
      opened={Boolean(seed)}
      seed={seed}
      onClose={close}
      onApply={apply}
      onRemove={remove}
    />
  );

  return { open, element };
}

export default LinkDialog;
