import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, Stack, Group, Text, Textarea, Button, ActionIcon, Paper, Tooltip, Badge } from '@mantine/core';
import { IconCheck, IconTrash, IconMessageCircle, IconQuote, IconAlertTriangle } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { quotePreview } from '../lib/commentAnchor.js';

/**
 * The quoted text a comment is attached to.
 *
 * An anchor that no longer resolves still shows its quote — the words are the
 * only record of what the comment was about, and hiding them would turn a
 * thread about a deleted sentence into a thread about nothing. It just stops
 * claiming to be a link to somewhere.
 */
function Quote({ anchor, orphaned }) {
  if (!anchor?.quote) return null;
  return (
    <Group gap={4} wrap="nowrap" align="flex-start" mb={6}>
      {orphaned ? (
        <IconAlertTriangle size={13} style={{ marginTop: 3, flexShrink: 0, opacity: 0.7 }} />
      ) : (
        <IconQuote size={13} style={{ marginTop: 3, flexShrink: 0, opacity: 0.7 }} />
      )}
      <Text size="xs" c="dimmed" className={`gd-comment-quote ${orphaned ? 'is-orphaned' : ''}`} lineClamp={2}>
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
  const orphaned = anchored && isResolvable && !isResolvable(c.id);

  return (
    <Paper
      withBorder
      p="xs"
      ml={isReply ? 24 : 0}
      opacity={c.resolved ? 0.6 : 1}
      className={anchored && !orphaned ? 'gd-comment-card is-anchored' : 'gd-comment-card'}
      // The whole card is the hover target, not just the quote: the pointer is
      // already going to the comment to read it, and asking someone to find a
      // small strip of text to hover would make the connection a secret.
      onMouseEnter={anchored && !orphaned ? () => onPreviewComment?.(c.id) : undefined}
      onMouseLeave={anchored && !orphaned ? () => onEndPreview?.(c.id) : undefined}
      // Keyboard users get the same thing on focus, and a click makes the jump
      // stick rather than fading when the pointer moves away.
      onFocus={anchored && !orphaned ? () => onPreviewComment?.(c.id) : undefined}
      onBlur={anchored && !orphaned ? () => onEndPreview?.(c.id) : undefined}
      tabIndex={anchored && !orphaned ? 0 : undefined}
    >
      <Group justify="space-between" mb={4}>
        <Group gap={6}>
          <Text size="sm" fw={600}>{c.user_name || 'Deleted user'}</Text>
          <Text size="xs" c="dimmed">{dayjs(c.created_at).format('MMM D, HH:mm')}</Text>
          {c.resolved && <Badge size="xs" color="green" variant="light">Resolved</Badge>}
        </Group>
        <Group gap={2}>
          {!isReply && (
            <Tooltip label={c.resolved ? 'Reopen' : 'Resolve'}>
              <ActionIcon size="xs" variant="subtle" color={c.resolved ? 'gray' : 'green'}
                onClick={() => api.patch(`/api/comments/${c.id}`, { resolved: !c.resolved }).then(load)}>
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
      {!isReply && <Quote anchor={c.anchor} orphaned={orphaned} />}
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

  // Arriving with a selection means the person has already decided what they
  // want to talk about; the only thing left to do is type, so the composer takes
  // focus and any half-written reply gets out of the way.
  useEffect(() => {
    if (!pendingAnchor) return;
    setReplyTo(null);
    composerRef.current?.focus();
  }, [pendingAnchor]);

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
    onClearPendingAnchor?.();
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
