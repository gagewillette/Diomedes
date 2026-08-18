import { useCallback, useEffect, useState } from 'react';
import { Drawer, Stack, Group, Text, Textarea, Button, ActionIcon, Paper, Tooltip, Badge } from '@mantine/core';
import { IconCheck, IconTrash, IconMessageCircle } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';

export default function CommentsPanel({ pageId, opened, onClose }) {
  const [comments, setComments] = useState([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const { user } = useAuth();

  const load = useCallback(async () => {
    const data = await api.get(`/api/pages/${pageId}/comments`);
    setComments(data.comments);
  }, [pageId]);

  useEffect(() => { if (opened) load(); }, [opened, load]);

  const submit = async () => {
    if (!draft.trim()) return;
    await api.post(`/api/pages/${pageId}/comments`, { content: draft, parentId: replyTo });
    setDraft('');
    setReplyTo(null);
    load();
  };

  const topLevel = comments.filter((c) => !c.parent_id);
  const repliesOf = (id) => comments.filter((c) => c.parent_id === id);

  const CommentCard = ({ c, isReply }) => (
    <Paper withBorder p="xs" ml={isReply ? 24 : 0} opacity={c.resolved ? 0.6 : 1}>
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
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{c.content}</Text>
      {!isReply && (
        <Button size="compact-xs" variant="subtle" mt={4} onClick={() => setReplyTo(c.id)}>Reply</Button>
      )}
    </Paper>
  );

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="md"
      title={<Group gap={6}><IconMessageCircle size={18} /><Text fw={700}>Comments</Text></Group>}>
      <Stack gap="sm">
        {topLevel.length === 0 && <Text c="dimmed" size="sm">No comments yet.</Text>}
        {topLevel.map((c) => (
          <div key={c.id}>
            <CommentCard c={c} isReply={false} />
            <Stack gap={6} mt={6}>
              {repliesOf(c.id).map((r) => <CommentCard key={r.id} c={r} isReply />)}
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
          <Textarea
            placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'}
            value={draft} onChange={(e) => setDraft(e.target.value)} autosize minRows={2}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          <Button size="compact-sm" mt="xs" onClick={submit} disabled={!draft.trim()}>
            {replyTo ? 'Reply' : 'Comment'}
          </Button>
        </Paper>
      </Stack>
    </Drawer>
  );
}
