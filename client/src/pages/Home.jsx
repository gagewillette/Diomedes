import { useCallback, useEffect, useState } from 'react';
import { Container, Title, Text, SimpleGrid, Card, Group, Stack, UnstyledButton, Divider } from '@mantine/core';
import { IconStar, IconClock, IconFileText } from '@tabler/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api, onAppEvent } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { pickGreeting, timeBucket } from '../lib/greetings.js';
import Emoji from '../components/Emoji.jsx';

dayjs.extend(relativeTime);

function PageRow({ page, onClick }) {
  return (
    <UnstyledButton className="gd-page-row" onClick={onClick}>
      <Group gap={8} wrap="nowrap">
        <span style={{ fontSize: 15 }}>{page.icon || <IconFileText size={15} opacity={0.6} />}</span>
        <Text size="sm" fw={500} truncate style={{ flex: 1 }}>{page.title || 'Untitled'}</Text>
        <Text size="xs" c="dimmed">{page.space_name}</Text>
        <Text size="xs" c="dimmed" w={90} ta="right">{dayjs(page.updated_at).fromNow()}</Text>
      </Group>
    </UnstyledButton>
  );
}

export default function Home() {
  const [recent, setRecent] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const { user, workspaceName } = useAuth();
  const navigate = useNavigate();
  const [greeting, setGreeting] = useState(() => pickGreeting(user.name));

  // Re-roll on a fresh visit, and again whenever the clock crosses into a new
  // part of the day so a long-lived tab never greets you with the wrong one.
  useEffect(() => {
    setGreeting(pickGreeting(user.name));
    let bucket = timeBucket(new Date().getHours());
    const id = setInterval(() => {
      const next = timeBucket(new Date().getHours());
      if (next === bucket) return;
      bucket = next;
      setGreeting(pickGreeting(user.name));
    }, 60_000);
    return () => clearInterval(id);
  }, [user.name]);

  const load = useCallback(() => {
    api.get('/api/pages/recent').then((d) => setRecent(d.pages)).catch(() => {});
    api.get('/api/favorites').then((d) => setFavorites(d.pages)).catch(() => {});
    api.get('/api/spaces').then((d) => setSpaces(d.spaces)).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  // Spaces gained or lost through a permission change should appear here too.
  useEffect(() => onAppEvent('spaces-changed', load), [load]);

  const go = (p) => navigate(`/s/${p.space_slug}/p/${p.id}`);

  return (
    <Container size="md" py="xl" px="lg" className="gd-fade-in">
      <Title order={2} mb={4}>{greeting}</Title>
      <Text c="dimmed" size="sm" mb="xl">{workspaceName}</Text>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} mb="xl">
        {spaces.map((s) => (
          <Card key={s.id} withBorder component={Link} to={`/s/${s.slug}`} className="gd-space-card">
            <Group gap={8}>
              <Emoji char={s.icon} size={22} />
              <div>
                <Text fw={700} size="sm">{s.name}</Text>
                <Text size="xs" c="dimmed">{s.page_count} page{s.page_count === 1 ? '' : 's'}</Text>
              </div>
            </Group>
          </Card>
        ))}
      </SimpleGrid>

      {favorites.length > 0 && (
        <>
          <Group gap={6} mb="xs"><IconStar size={16} /><Title order={5}>Favorites</Title></Group>
          <Stack gap={2} mb="xl">
            {favorites.map((p) => <PageRow key={p.id} page={p} onClick={() => go(p)} />)}
          </Stack>
          <Divider mb="xl" />
        </>
      )}

      <Group gap={6} mb="xs"><IconClock size={16} /><Title order={5}>Recently updated</Title></Group>
      <Stack gap={2}>
        {recent.map((p) => <PageRow key={p.id} page={p} onClick={() => go(p)} />)}
        {recent.length === 0 && <Text c="dimmed" size="sm">No pages yet — create one from a space in the sidebar.</Text>}
      </Stack>
    </Container>
  );
}
