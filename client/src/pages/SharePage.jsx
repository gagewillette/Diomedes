import { useEffect, useState } from 'react';
import { Container, Title, Text, Center, Loader, Group, Divider } from '@mantine/core';
import { useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import Editor from '../editor/Editor.jsx';
import FindBar from '../components/FindBar.jsx';
import Emoji from '../components/Emoji.jsx';

export default function SharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    api.get(`/api/public/${token}`, { noRedirect: true })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [token]);

  // Ctrl+F → in-document find on shared pages too.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'f') {
        e.preventDefault();
        setFindOpen(true);
        document.querySelector('.gd-findbar input')?.select();
      }
      if (e.key === 'Escape') setFindOpen(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  if (error)
    return (
      <Center h="100vh">
        <Text c="dimmed">{error}</Text>
      </Center>
    );
  if (!data)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );

  return (
    <Container size="md" py="xl" px="lg">
      <Group gap={8} align="flex-start" wrap="nowrap">
        {data.page.icon && <Emoji char={data.page.icon} size={40} />}
        <Title order={1} style={{ fontSize: 34 }}>{data.page.title || 'Untitled'}</Title>
      </Group>
      <Text size="xs" c="dimmed" mt={4} mb="md">
        Shared from {data.workspaceName} · Last updated {dayjs(data.page.updated_at).format('MMM D, YYYY')}
      </Text>
      <Divider mb="md" />
      <Editor content={data.page.content} editable={false} onReady={setEditor} />
      <FindBar editor={editor} opened={findOpen} onClose={() => setFindOpen(false)} />
    </Container>
  );
}
