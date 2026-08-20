import { useCallback, useEffect, useState } from 'react';
import {
  AppShell, Group, Text, ActionIcon, Menu, UnstyledButton, ScrollArea, Divider,
  TextInput, Avatar, Tooltip, useMantineColorScheme, Modal, Button, Stack, Burger, Collapse,
} from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import {
  IconSearch, IconHome, IconPlus, IconSun, IconMoon, IconLogout, IconSettings,
  IconUsers, IconChevronDown, IconChevronRight, IconLayoutSidebarLeftCollapse, IconBuilding,
  IconGauge,
} from '@tabler/icons-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { useAuth } from '../lib/AuthContext.jsx';
import { api } from '../lib/api.js';
import { startRoute, settleRoute } from '../lib/perf.js';
import { focusEditor, focusFileTree } from '../lib/vimFocus.js';
import PageTree from './PageTree.jsx';
import SearchModal from './SearchModal.jsx';
import Emoji from './Emoji.jsx';

const NAV_WIDTH_KEY = 'gd-nav-width';
const NAV_WIDTH_DEFAULT = 280;
const NAV_WIDTH_MIN = 190;
const NAV_WIDTH_MAX = 560;

const clampNavWidth = (w) => Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, Math.round(w)));

const readStoredNavWidth = () => {
  const stored = Number(localStorage.getItem(NAV_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampNavWidth(stored) : NAV_WIDTH_DEFAULT;
};

export default function Layout({ children }) {
  const { user, workspaceName, logout, isAdmin, preferences } = useAuth();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const [spaces, setSpaces] = useState([]);
  const [openSpaces, setOpenSpaces] = useState(() => new Set());
  const [searchOpen, searchHandlers] = useDisclosure(false);
  const [newSpaceOpen, newSpaceHandlers] = useDisclosure(false);
  const [navOpen, navHandlers] = useDisclosure(true);
  const [newSpace, setNewSpace] = useState({ name: '', icon: '📚', description: '' });
  const [navWidth, setNavWidth] = useState(readStoredNavWidth);
  const [resizing, setResizing] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const slug = pathname.startsWith('/s/') ? pathname.split('/')[2] : null;

  // Time every in-app navigation. The clock starts here, before the new screen
  // renders, and stops when that screen's data lands (markPageReady) — or two
  // frames later for screens with nothing to fetch.
  useEffect(() => {
    startRoute(pathname);
    settleRoute();
  }, [pathname]);

  useHotkeys([['mod+K', () => searchHandlers.open()]]);

  // Vim's window motions, scaled down to the two panes this app has: Ctrl+H to
  // the page tree, Ctrl+L back to the document. Capture phase, because in
  // normal mode the editor is swallowing keystrokes of its own.
  const vim = preferences.keymap === 'vim';
  useEffect(() => {
    if (!vim) return undefined;
    const handler = (e) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        navHandlers.open();
        focusFileTree();
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        focusEditor();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [vim, navHandlers]);

  const loadSpaces = useCallback(async () => {
    const data = await api.get('/api/spaces');
    setSpaces(data.spaces);
  }, []);

  useEffect(() => { loadSpaces(); }, [loadSpaces]);

  useEffect(() => { localStorage.setItem(NAV_WIDTH_KEY, String(navWidth)); }, [navWidth]);

  // drag the handle on the navbar's right edge to resize it
  useEffect(() => {
    if (!resizing) return undefined;
    const onMove = (e) => setNavWidth(clampNavWidth(e.clientX));
    const stop = () => setResizing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  const onResizerKeyDown = (e) => {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setNavWidth((w) => clampNavWidth(w - step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setNavWidth((w) => clampNavWidth(w + step)); }
    else if (e.key === 'Home') { e.preventDefault(); setNavWidth(NAV_WIDTH_MIN); }
    else if (e.key === 'End') { e.preventDefault(); setNavWidth(NAV_WIDTH_MAX); }
  };
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
      navbar={{ width: navWidth, breakpoint: 'sm', collapsed: { mobile: !navOpen, desktop: !navOpen } }}
      padding={0}
    >
      <AppShell.Navbar p="xs">
        <Group justify="space-between" px={4} mb={4} wrap="nowrap">
          <UnstyledButton component={Link} to="/" className="gd-nav-title" title={workspaceName}>
            <Group gap={8} wrap="nowrap">
              <span className="gd-tree-icon">📝</span>
              <Text fw={800} size="md" truncate>{workspaceName}</Text>
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
                  <>
                    <Menu.Item leftSection={<IconUsers size={14} />} component={Link} to="/settings/members">
                      Manage users
                    </Menu.Item>
                    <Menu.Item leftSection={<IconGauge size={14} />} component={Link} to="/settings/workspace/info">
                      Workspace info
                    </Menu.Item>
                    <Menu.Item leftSection={<IconBuilding size={14} />} component={Link} to="/settings/workspace">
                      Workspace settings
                    </Menu.Item>
                  </>
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
                  <UnstyledButton className="gd-tree-label" component={Link} to={`/s/${space.slug}`} title={space.name}>
                    <Group gap={6} wrap="nowrap">
                      <span className="gd-tree-icon"><Emoji char={space.icon} size={15} /></span>
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

        <div
          className={`gd-nav-resizer ${resizing ? 'is-resizing' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={navWidth}
          aria-valuemin={NAV_WIDTH_MIN}
          aria-valuemax={NAV_WIDTH_MAX}
          tabIndex={0}
          onPointerDown={(e) => { e.preventDefault(); setResizing(true); }}
          onDoubleClick={() => setNavWidth(NAV_WIDTH_DEFAULT)}
          onKeyDown={onResizerKeyDown}
        />
      </AppShell.Navbar>

      <AppShell.Main className={navOpen ? undefined : 'gd-nav-collapsed'}>
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
