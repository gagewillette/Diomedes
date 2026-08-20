import { useCallback, useEffect, useRef, useState } from 'react';
import { getMarkRange } from '@tiptap/core';
import { ActionIcon, Group, Paper, Portal, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle, IconCheck, IconCopy, IconExternalLink, IconLinkOff, IconPencil, IconShieldX,
} from '@tabler/icons-react';
import { normalizeUrl, linkHost, linkSafety, isExternalUrl } from './linkUrl.js';

// How long the pointer has to rest on a link before the card appears, and how
// long the card survives after the pointer leaves. The second delay is what
// makes the card reachable: without it, moving the mouse from the link down to
// the Copy button would dismiss the thing you were reaching for.
const SHOW_DELAY = 300;
const HIDE_DELAY = 200;

const LEVELS = {
  safe: { color: 'green', Icon: IconCheck },
  caution: { color: 'yellow', Icon: IconAlertTriangle },
  unsafe: { color: 'red', Icon: IconShieldX },
};

/** The mark range behind an anchor element, or null if it isn't a link mark. */
function rangeForAnchor(editor, anchor) {
  const linkType = editor.schema.marks.link;
  if (!linkType) return null;
  let pos;
  try {
    pos = editor.view.posAtDOM(anchor, 0);
  } catch {
    return null;
  }
  const { doc } = editor.state;
  // One step in: at the mark's own boundary the position belongs to both the
  // link and the text before it, and asking there can return the wrong range.
  const $pos = doc.resolve(Math.min(pos + 1, doc.content.size));
  return getMarkRange($pos, linkType);
}

/** The address without the scheme — what Docs shows, and what people read. */
function readableUrl(href) {
  return href.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function HoverCard({ state, editor, onEdit, onKeep, onDismiss }) {
  const { href, rect } = state;
  const verdict = linkSafety(href);
  const { color, Icon } = LEVELS[verdict.level] ?? LEVELS.caution;
  const host = linkHost(href);
  const external = isExternalUrl(href);
  const canEdit = Boolean(editor?.isEditable);

  const open = () => {
    const safe = normalizeUrl(href);
    if (!safe) return;
    if (!external) {
      globalThis.location.href = safe;
      return;
    }
    window.open(safe, '_blank', 'noopener,noreferrer');
  };

  const copy = () => {
    navigator.clipboard?.writeText(normalizeUrl(href) || href).catch(() => {});
    onDismiss();
  };

  const unlink = () => {
    const range = state.range;
    if (!range) return;
    editor.chain().focus().setTextSelection(range).unsetLink().run();
    onDismiss();
  };

  // Clamped so a link near the right edge or the bottom of the window still
  // gets a card that is entirely on screen.
  const width = 380;
  const left = Math.max(8, Math.min(rect.left, globalThis.innerWidth - width - 8));
  const below = rect.bottom + 8;
  const flip = below + 120 > globalThis.innerHeight;
  const top = flip ? Math.max(8, rect.top - 8) : below;

  return (
    <Portal>
      <Paper
        shadow="md"
        withBorder
        p="xs"
        role="dialog"
        aria-label="Link preview"
        onMouseEnter={onKeep}
        onMouseLeave={onDismiss}
        style={{
          position: 'fixed',
          left,
          top,
          width,
          transform: flip ? 'translateY(-100%)' : undefined,
          zIndex: 320,
        }}
      >
        <Stack gap={4}>
          {/* Top row: where this goes, and what you can do about it. The
              address and the verdict get the full width underneath, because a
              host truncated to "docs.exam…" answers nothing. */}
          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
              <ActionIcon
                variant="light"
                color={color}
                size="sm"
                radius="xl"
                component="div"
                aria-label={`Link safety: ${verdict.label}`}
                style={{ flexShrink: 0, cursor: 'default' }}
              >
                <Icon size={14} />
              </ActionIcon>
              <Text size="sm" fw={600} truncate>
                {host || 'This wiki'}
              </Text>
              <Text size="xs" c={color} fw={600} style={{ flexShrink: 0 }}>
                {verdict.label}
              </Text>
            </Group>

            <Group gap={0} wrap="nowrap" style={{ flexShrink: 0 }}>
              <Tooltip label={external ? 'Open in a new tab' : 'Open'} withArrow>
                <ActionIcon variant="subtle" color="gray" size="sm" onClick={open} aria-label="Open link">
                  <IconExternalLink size={15} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Copy address" withArrow>
                <ActionIcon variant="subtle" color="gray" size="sm" onClick={copy} aria-label="Copy link address">
                  <IconCopy size={15} />
                </ActionIcon>
              </Tooltip>
              {canEdit && (
                <>
                  <Tooltip label="Edit link" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      onClick={() => { onEdit?.(state.range); onDismiss(); }}
                      aria-label="Edit link"
                    >
                      <IconPencil size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove link" withArrow>
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={unlink} aria-label="Remove link">
                      <IconLinkOff size={15} />
                    </ActionIcon>
                  </Tooltip>
                </>
              )}
            </Group>
          </Group>

          <Text size="xs" c="dimmed" truncate title={href}>
            {readableUrl(href)}
          </Text>
          <Text size="xs" c={verdict.level === 'safe' ? 'dimmed' : color}>
            {verdict.reason}
          </Text>
        </Stack>
      </Paper>
    </Portal>
  );
}

/**
 * The card that appears under a link on hover, the way it does in Docs: where
 * the link actually goes, and what we make of it.
 *
 * The point is the gap between what a link says and where it leads. The text
 * can read "the release notes" and point anywhere, and in a wiki anyone on the
 * team can write that text. So the card leads with the host, and the traffic
 * light beside it is a judgement about the address itself — see `linkSafety`.
 *
 * It runs for readers as well as writers; the edit and remove buttons are the
 * only part that depends on being able to edit.
 */
export function useLinkHoverCard({ editor, onEdit }) {
  const [state, setState] = useState(null);
  const timers = useRef({ show: null, hide: null });

  const clearTimers = () => {
    clearTimeout(timers.current.show);
    clearTimeout(timers.current.hide);
  };

  const dismiss = useCallback(() => {
    clearTimers();
    timers.current.hide = setTimeout(() => setState(null), HIDE_DELAY);
  }, []);

  const keep = useCallback(() => clearTimeout(timers.current.hide), []);

  useEffect(() => {
    const dom = editor?.view?.dom;
    if (!dom) return undefined;

    const linkAt = (target) => {
      const from = target?.nodeType === 3 ? target.parentElement : target;
      const anchor = from?.closest?.('a[href]');
      if (!anchor || !dom.contains(anchor)) return null;
      // Page-link chips and the node views draw their own anchors and have
      // their own affordances; only `link` marks get a card.
      const range = rangeForAnchor(editor, anchor);
      if (!range) return null;
      const href = anchor.getAttribute('href');
      return normalizeUrl(href) || href ? { anchor, range, href } : null;
    };

    const onOver = (event) => {
      const hit = linkAt(event.target);
      if (!hit) return;
      clearTimers();
      timers.current.show = setTimeout(() => {
        // Re-read the rectangle at show time: the document may have moved
        // under the pointer while the delay was running.
        setState({
          href: hit.href,
          range: hit.range,
          rect: hit.anchor.getBoundingClientRect(),
        });
      }, SHOW_DELAY);
    };

    const onOut = (event) => {
      if (!linkAt(event.target)) return;
      // Moving from the link onto the card must not close it; the card's own
      // mouseenter cancels this within the grace period.
      dismiss();
    };

    // Any scroll moves the link out from under its card, and a card left
    // floating over unrelated text is worse than no card.
    const onScroll = () => { clearTimers(); setState(null); };

    dom.addEventListener('mouseover', onOver);
    dom.addEventListener('mouseout', onOut);
    globalThis.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimers();
      dom.removeEventListener('mouseover', onOver);
      dom.removeEventListener('mouseout', onOut);
      globalThis.removeEventListener('scroll', onScroll, true);
    };
  }, [editor, dismiss]);

  const element = state ? (
    <HoverCard
      state={state}
      editor={editor}
      onEdit={onEdit}
      onKeep={keep}
      onDismiss={() => { clearTimers(); setState(null); }}
    />
  ) : null;

  return { element, hide: () => { clearTimers(); setState(null); } };
}

export default HoverCard;
