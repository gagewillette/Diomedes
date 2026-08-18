import { useEffect, useState } from 'react';
import { Container, Title, Text, Center, Loader, Group, Divider } from '@mantine/core';
import { useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import Editor from '../editor/Editor.jsx';

export default function SharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/api/public/${token}`, { noRedirect: true })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [token]);

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
        {data.page.icon && <Text style={{ fontSize: 38, lineHeight: 1.2 }}>{data.page.icon}</Text>}
        <Title order={1} style={{ fontSize: 34 }}>{data.page.title || 'Untitled'}</Title>
      </Group>
      <Text size="xs" c="dimmed" mt={4} mb="md">
        Shared from {data.workspaceName} · Last updated {dayjs(data.page.updated_at).format('MMM D, YYYY')}
      </Text>
      <Divider mb="md" />
      <Editor content={data.page.content} editable={false} />
    </Container>
  );
}
