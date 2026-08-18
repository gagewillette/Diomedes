import { useCallback, useEffect, useState } from 'react';
import {
  AppShell, Group, Text, ActionIcon, Menu, UnstyledButton, ScrollArea, Divider,
  TextInput, Avatar, Tooltip, useMantineColorScheme, Modal, Button, Stack, Burger, Collapse,
} from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import {
  IconSearch, IconHome, IconPlus, IconSun, IconMoon, IconLogout, IconSettings,
  IconUsers, IconChevronDown, IconChevronRight, IconLayoutSidebarLeftCollapse,
} from '@tabler/icons-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { useAuth } from '../lib/AuthContext.jsx';
import { api } from '../lib/api.js';
import PageTree from './PageTree.jsx';
import SearchModal from './SearchModal.jsx';

export default function Layout({ children }) {
  const { user, workspaceName, logout, isAdmin, preferences } = useAuth();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const [spaces, setSpaces] = useState([]);
  const [openSpaces, setOpenSpaces] = useState(() => new Set());
  const [searchOpen, searchHandlers] = useDisclosure(false);
  const [newSpaceOpen, newSpaceHandlers] = useDisclosure(false);
  const [navOpen, navHandlers] = useDisclosure(true);
  const [newSpace, setNewSpace] = useState({ name: '', icon: '📚', description: '' });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const slug = pathname.startsWith('/s/') ? pathname.split('/')[2] : null;

  useHotkeys([['mod+K', () => searchHandlers.open()]]);

  const loadSpaces = useCallback(async () => {
    const data = await api.get('/api/spaces');
    setSpaces(data.spaces);
  }, []);

  useEffect(() => { loadSpaces(); }, [loadSpaces]);
  useEffect(() => {
    const handler = () => loadSpaces();
    window.addEventListener('spaces-changed', handler);
    return () => window.removeEventListener('spaces-changed', handler);
  }, [loadSpaces]);

  // keep the space of the current route expanded
  useEffect(() => {
    if (!slug) return;
    const space = spaces.find((s) => s.slug === slug);
    if (space) setOpenSpaces((prev) => new Set([...prev, space.id]));
  }, [slug, spaces]);

  const createSpace = async () => {
    try {
      const data = await api.post('/api/spaces', newSpace);
      newSpaceHandlers.close();
      setNewSpace({ name: '', icon: '📚', description: '' });
      await loadSpaces();
      navigate(`/s/${data.space.slug}`);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  return (
    <AppShell
      className={preferences.animations ? '' : 'gd-anim-off'}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: !navOpen, desktop: !navOpen } }}
      padding={0}
    >
      <AppShell.Navbar p="xs">
        <Group justify="space-between" px={4} mb={4} wrap="nowrap">
          <UnstyledButton component={Link} to="/">
            <Group gap={8} wrap="nowrap">
              <Text fw={800} size="md" truncate>📝 {workspaceName}</Text>
            </Group>
          </UnstyledButton>
          <Group gap={2} wrap="nowrap">
            <Tooltip label="Collapse sidebar">
              <ActionIcon variant="subtle" color="gray" onClick={navHandlers.close}>
                <IconLayoutSidebarLeftCollapse size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme}>
                {colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
              </ActionIcon>
            </Tooltip>
            <Menu withinPortal position="bottom-end" shadow="md">
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray">
                  <Avatar size={22} radius="xl" color="blue">{user.name[0]?.toUpperCase()}</Avatar>
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user.name} (@{user.username})</Menu.Label>
                <Menu.Item leftSection={<IconSettings size={14} />} component={Link} to="/settings">
                  Account settings
                </Menu.Item>
                {isAdmin && (
                  <Menu.Item leftSection={<IconUsers size={14} />} component={Link} to="/settings/members">
                    Manage users
                  </Menu.Item>
                )}
                <Menu.Divider />
                <Menu.Item leftSection={<IconLogout size={14} />} onClick={logout}>Log out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>

        <TextInput
          readOnly value="" placeholder="Search  (Ctrl+K)" size="xs" mb={6}
          leftSection={<IconSearch size={14} />}
          onClick={searchHandlers.open}
          styles={{ input: { cursor: 'pointer' } }}
        />
        <UnstyledButton component={Link} to="/" className="gd-nav-link">
          <Group gap={8}><IconHome size={15} /><Text size="sm">Home</Text></Group>
        </UnstyledButton>
        <Divider my={6} />
        <Group justify="space-between" px={4}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Spaces</Text>
          {isAdmin && (
            <Tooltip label="New space">
              <ActionIcon size="xs" variant="subtle" color="gray" onClick={newSpaceHandlers.open}>
                <IconPlus size={13} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <AppShell.Section grow component={ScrollArea} mt={4}>
          {spaces.map((space) => {
            const open = openSpaces.has(space.id);
            return (
              <div key={space.id}>
                <Group gap={2} wrap="nowrap" className="gd-space-row">
                  <ActionIcon
                    size="xs" variant="subtle" color="gray"
                    onClick={() =>
                      setOpenSpaces((prev) => {
                        const next = new Set(prev);
                        next.has(space.id) ? next.delete(space.id) : next.add(space.id);
                        return next;
                      })
                    }
                  >
                    {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                  </ActionIcon>
                  <UnstyledButton className="gd-tree-label" component={Link} to={`/s/${space.slug}`}>
                    <Group gap={6} wrap="nowrap">
                      <span>{space.icon}</span>
                      <Text size="sm" fw={600} truncate>{space.name}</Text>
                    </Group>
                  </UnstyledButton>
                </Group>
                <Collapse in={open} transitionDuration={preferences.animations ? 180 : 0}>
                  <PageTree space={space} />
                </Collapse>
              </div>
            );
          })}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {!navOpen && (
          <Burger
            opened={false} onClick={navHandlers.open} size="sm"
            style={{ position: 'fixed', top: 8, left: 10, zIndex: 200 }}
            className="gd-burger"
          />
        )}
        {children}
      </AppShell.Main>

      <SearchModal opened={searchOpen} onClose={searchHandlers.close} />

      <Modal opened={newSpaceOpen} onClose={newSpaceHandlers.close} title="Create space">
        <Stack>
          <TextInput label="Name" value={newSpace.name} data-autofocus
            onChange={(e) => setNewSpace({ ...newSpace, name: e.target.value })} />
          <TextInput label="Icon (emoji)" value={newSpace.icon}
            onChange={(e) => setNewSpace({ ...newSpace, icon: e.target.value })} />
          <TextInput label="Description" value={newSpace.description}
            onChange={(e) => setNewSpace({ ...newSpace, description: e.target.value })} />
          <Button onClick={createSpace} disabled={!newSpace.name.trim()}>Create</Button>
        </Stack>
      </Modal>
    </AppShell>
  );
}
