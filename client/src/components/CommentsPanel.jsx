import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, Stack, Group, Text, Textarea, Button, ActionIcon, Paper, Tooltip, Badge } from '@mantine/core';
import { IconCheck, IconTrash, IconMessageCircle, IconQuote, IconAlertTriangle } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { quotePreview } from '../lib/commentAnchor.js';
import { pickUserColor } from '../lib/userColor.js';

/**
 * The quoted text a comment is attached to.
 *
 * An anchor that no longer resolves still shows its quote — the words are the
 * only record of what the comment was about, and hiding them would turn a
 * thread about a deleted sentence into a thread about nothing. It just stops
 * claiming to be a link to somewhere.
 */
function Quote({ anchor, orphaned, resolved, color }) {
  if (!anchor?.quote) return null;
  const state = orphaned ? 'is-orphaned' : resolved ? 'is-resolved' : '';
  return (
    <Group gap={4} wrap="nowrap" align="flex-start" mb={6}>
      {orphaned ? (
        <IconAlertTriangle size={13} style={{ marginTop: 3, flexShrink: 0, opacity: 0.7 }} />
      ) : (
        <IconQuote size={13} style={{ marginTop: 3, flexShrink: 0, opacity: 0.7 }} />
      )}
      <Text
        size="xs"
        c="dimmed"
        className={`gd-comment-quote ${state}`}
        // The same custom property the highlight publishes, so the rule beside
        // the quote is the colour of the highlight it refers to.
        style={{ '--gd-comment-color': color }}
        lineClamp={2}
      >
        {quotePreview(anchor)}
      </Text>
    </Group>
  );
}

/**
 * One comment.
 *
 * Deliberately a module-level component rather than one defined inside the
 * panel. A component redeclared on every render has a new identity every time,
 * so React unmounts and remounts the whole list on each keystroke in the
 * composer below — which with these hover handlers attached would fire
 * mouseleave/mouseenter on the card under the pointer and make the highlight in
 * the document flicker while someone is typing about it.
 */
function CommentCard({ c, isReply, user, load, isResolvable, onPreviewComment, onEndPreview, onReply }) {
  // A thread's anchor lives on its first comment, so a reply is "about" the
  // same text and gets the same hover behaviour without repeating the quote.
  const anchored = Boolean(c.anchor?.quote);
  // A resolved comment is settled, not broken: it is deliberately not drawn on
  // the page, so it must not be reported as text that has gone missing either.
  const orphaned = anchored && !c.resolved && isResolvable && !isResolvable(c.id);
  // Nothing is highlighted for a resolved comment, so there is nothing for a
  // hover to show.
  const linked = anchored && !c.resolved && !orphaned;
  const color = pickUserColor(c.user_id);

  // The second click on Resolve removes the thread. Only offered to someone who
  // could delete it anyway — the same test the bin uses, because the delete
  // route it ends up calling applies exactly that rule server-side. For everyone
  // else the button stays a toggle, which is still the useful thing to have.
  const mine = c.user_id === user.id;
  const resolveAction = !c.resolved
    ? { label: 'Resolve', run: () => api.patch(`/api/comments/${c.id}`, { resolved: true }).then(load) }
    : mine
      ? { label: 'Remove this comment', run: () => api.del(`/api/comments/${c.id}`).then(load) }
      : { label: 'Reopen', run: () => api.patch(`/api/comments/${c.id}`, { resolved: false }).then(load) };

  return (
    <Paper
      withBorder
      p="xs"
      ml={isReply ? 24 : 0}
      opacity={c.resolved ? 0.6 : 1}
      className={linked ? 'gd-comment-card is-anchored' : 'gd-comment-card'}
      style={{ '--gd-comment-color': color }}
      // The whole card is the hover target, not just the quote: the pointer is
      // already going to the comment to read it, and asking someone to find a
      // small strip of text to hover would make the connection a secret.
      onMouseEnter={linked ? () => onPreviewComment?.(c.id) : undefined}
      onMouseLeave={linked ? () => onEndPreview?.(c.id) : undefined}
      // Keyboard users get the same thing on focus, and a click makes the jump
      // stick rather than fading when the pointer moves away.
      onFocus={linked ? () => onPreviewComment?.(c.id) : undefined}
      onBlur={linked ? () => onEndPreview?.(c.id) : undefined}
      tabIndex={linked ? 0 : undefined}
    >
      <Group justify="space-between" mb={4}>
        <Group gap={6}>
          <Text size="sm" fw={600}>{c.user_name || 'Deleted user'}</Text>
          <Text size="xs" c="dimmed">{dayjs(c.created_at).format('MMM D, HH:mm')}</Text>
          {c.resolved && <Badge size="xs" color="green" variant="light">Resolved</Badge>}
        </Group>
        <Group gap={2}>
          {!isReply && (
            <Tooltip label={resolveAction.label}>
              <ActionIcon
                size="xs"
                variant="subtle"
                color={c.resolved ? 'gray' : 'green'}
                aria-label={resolveAction.label}
                onClick={resolveAction.run}
              >
                <IconCheck size={13} />
              </ActionIcon>
            </Tooltip>
          )}
          {c.user_id === user.id && (
            <ActionIcon size="xs" variant="subtle" color="red"
              onClick={() => api.del(`/api/comments/${c.id}`).then(load)}>
              <IconTrash size={13} />
            </ActionIcon>
          )}
        </Group>
      </Group>
      {!isReply && <Quote anchor={c.anchor} orphaned={orphaned} resolved={c.resolved} color={color} />}
      {orphaned && (
        <Text size="xs" c="dimmed" fs="italic" mb={4}>
          The text this refers to is no longer on the page.
        </Text>
      )}
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{c.content}</Text>
      {!isReply && (
        <Button size="compact-xs" variant="subtle" mt={4} onClick={() => onReply(c.id)}>Reply</Button>
      )}
    </Paper>
  );
}

export default function CommentsPanel({
  pageId,
  opened,
  onClose,
  comments,
  onReload,
  // The anchor a "Comment on this text" click arrived with, if the panel was
  // opened that way. Held by the page rather than here, because the selection
  // it describes belongs to the editor.
  pendingAnchor = null,
  onClearPendingAnchor,
  onCommentPosted,
  // Hover in, hover out, and "can this comment be jumped to at all" — all three
  // come from the editor, which is the only thing that knows where the text
  // currently is.
  onPreviewComment,
  onEndPreview,
  isResolvable,
}) {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const { user } = useAuth();
  const composerRef = useRef(null);

  const load = useCallback(() => onReload?.(), [onReload]);

  useEffect(() => { if (opened) load(); }, [opened, load]);

  // Opening the panel means the person has decided to say something; the only
  // thing left to do is type, so the composer takes focus.
  //
  // Keyed on `opened` and nothing else. Following the pending anchor here would
  // pull focus out of whatever they were doing on every selection change now
  // that the anchor tracks the selection live — including mid-drag, while they
  // are still choosing the phrase.
  useEffect(() => {
    if (!opened) return;
    setReplyTo(null);
    composerRef.current?.focus();
  }, [opened]);

  const submit = async () => {
    if (!draft.trim()) return;
    await api.post(`/api/pages/${pageId}/comments`, {
      content: draft,
      parentId: replyTo,
      // A reply joins an existing thread, and the thread already has the anchor.
      anchor: replyTo ? null : pendingAnchor,
    });
    setDraft('');
    setReplyTo(null);
    // Back to following the selection: the next comment is a new decision.
    onCommentPosted?.();
    load();
  };

  const all = comments || [];
  const topLevel = all.filter((c) => !c.parent_id);
  const repliesOf = (id) => all.filter((c) => c.parent_id === id);

  const cardProps = { user, load, isResolvable, onPreviewComment, onEndPreview, onReply: setReplyTo };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      // No overlay, no scroll lock, no close-on-click-outside: the whole point
      // of an anchored comment is that hovering it shows you the text it is
      // about, and a dimmed, frozen, click-to-dismiss document cannot do that.
      withOverlay={false}
      lockScroll={false}
      closeOnClickOutside={false}
      trapFocus={false}
      className="gd-comments-drawer"
      title={<Group gap={6}><IconMessageCircle size={18} /><Text fw={700}>Comments</Text></Group>}
    >
      <Stack gap="sm">
        {topLevel.length === 0 && <Text c="dimmed" size="sm">No comments yet.</Text>}
        {topLevel.map((c) => (
          <div key={c.id}>
            <CommentCard c={c} isReply={false} {...cardProps} />
            <Stack gap={6} mt={6}>
              {repliesOf(c.id).map((r) => <CommentCard key={r.id} c={r} isReply {...cardProps} />)}
            </Stack>
          </div>
        ))}
        <Paper withBorder p="xs">
          {replyTo && (
            <Group justify="space-between" mb={4}>
              <Text size="xs" c="dimmed">Replying to a comment</Text>
              <Button size="compact-xs" variant="subtle" onClick={() => setReplyTo(null)}>Cancel</Button>
            </Group>
          )}
          {pendingAnchor && !replyTo && (
            <Group justify="space-between" mb={4} wrap="nowrap" align="flex-start">
              <Group gap={4} wrap="nowrap" align="flex-start">
                <IconQuote size={13} style={{ marginTop: 3, flexShrink: 0, opacity: 0.7 }} />
                <Text size="xs" c="dimmed" className="gd-comment-quote" lineClamp={2}>
                  {quotePreview(pendingAnchor)}
                </Text>
              </Group>
              <Button size="compact-xs" variant="subtle" onClick={onClearPendingAnchor}>Clear</Button>
            </Group>
          )}
          <Textarea
            ref={composerRef}
            placeholder={
              replyTo ? 'Write a reply…' : pendingAnchor ? 'Comment on the selected text…' : 'Write a comment…'
            }
            value={draft} onChange={(e) => setDraft(e.target.value)} autosize minRows={2}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          <Button size="compact-sm" mt="xs" onClick={submit} disabled={!draft.trim()}>
            {replyTo ? 'Reply' : pendingAnchor ? 'Comment on text' : 'Comment'}
          </Button>
        </Paper>
      </Stack>
    </Drawer>
  );
}
