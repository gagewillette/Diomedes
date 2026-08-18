import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Title, Text, Group, Button, Stack, UnstyledButton, Modal, Table, Select,
  TextInput, ActionIcon, Tooltip, Menu, Loader, Center,
} from '@mantine/core';
import {
  IconPlus, IconTrash, IconUsers, IconSettings, IconFileImport, IconRestore,
  IconFileText, IconDots, IconX,
} from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import { api, emitPagesChanged } from '../lib/api.js';
import { markdownToJSON } from '../lib/markdown.js';
import { useAuth } from '../lib/AuthContext.jsx';

export default function SpaceHome() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [space, setSpace] = useState(null);
  const [pages, setPages] = useState([]);
  const [membersOpen, membersHandlers] = useDisclosure(false);
  const [trashOpen, trashHandlers] = useDisclosure(false);
  const [settingsOpen, settingsHandlers] = useDisclosure(false);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/api/spaces/${slug}`);
      setSpace(d.space);
      const p = await api.get(`/api/spaces/${d.space.id}/pages`);
      setPages(p.pages.filter((x) => !x.parent_id));
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
      navigate('/');
    }
  }, [slug, navigate]);

  useEffect(() => { load(); }, [load]);

  if (!space) return <Center h="60vh"><Loader /></Center>;
  const canWrite = ['admin', 'writer'].includes(space.my_role);
  const isSpaceAdmin = space.my_role === 'admin';

  const newPage = async () => {
    const d = await api.post('/api/pages', { spaceId: space.id });
    emitPagesChanged(space.id);
    navigate(`/s/${slug}/p/${d.page.id}`);
  };

  const importMarkdown = async (files) => {
    let imported = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        const title = file.name.replace(/\.(md|markdown|txt)$/i, '');
        const d = await api.post('/api/pages', { spaceId: space.id, title });
        await api.patch(`/api/pages/${d.page.id}`, { content: markdownToJSON(text), title });
        imported++;
      } catch (err) {
        notifications.show({ color: 'red', message: `${file.name}: ${err.message}` });
      }
    }
    if (imported) {
      notifications.show({ color: 'green', message: `Imported ${imported} page${imported === 1 ? '' : 's'}` });
      emitPagesChanged(space.id);
      load();
    }
  };

  return (
    <Container size="md" py="xl" px="lg" className="gd-fade-in">
      <Group justify="space-between" mb="xs">
        <Group gap={10}>
          <Text style={{ fontSize: 34 }}>{space.icon}</Text>
          <div>
            <Title order={2}>{space.name}</Title>
            {space.description && <Text c="dimmed" size="sm">{space.description}</Text>}
          </div>
        </Group>
        <Group gap={6}>
          {canWrite && (
            <>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={newPage}>New page</Button>
              <Tooltip label="Import markdown files">
                <ActionIcon variant="default" onClick={() => fileInputRef.current?.click()}>
                  <IconFileImport size={16} />
                </ActionIcon>
              </Tooltip>
              <input
                ref={fileInputRef} type="file" accept=".md,.markdown,.txt" multiple hidden
                onChange={(e) => { importMarkdown(Array.from(e.target.files)); e.target.value = ''; }}
              />
              <Tooltip label="Trash">
                <ActionIcon variant="default" onClick={trashHandlers.open}><IconTrash size={16} /></ActionIcon>
              </Tooltip>
            </>
          )}
          {isSpaceAdmin && (
            <>
              <Tooltip label="Members">
                <ActionIcon variant="default" onClick={membersHandlers.open}><IconUsers size={16} /></ActionIcon>
              </Tooltip>
              <Tooltip label="Space settings">
                <ActionIcon variant="default" onClick={settingsHandlers.open}><IconSettings size={16} /></ActionIcon>
              </Tooltip>
            </>
          )}
        </Group>
      </Group>

      <Stack gap={2} mt="lg">
        {pages.map((p) => (
          <UnstyledButton key={p.id} className="gd-page-row" onClick={() => navigate(`/s/${slug}/p/${p.id}`)}>
            <Group gap={8} wrap="nowrap">
              <span style={{ fontSize: 15 }}>{p.icon || <IconFileText size={15} opacity={0.6} />}</span>
              <Text size="sm" fw={500} truncate style={{ flex: 1 }}>{p.title || 'Untitled'}</Text>
              <Text size="xs" c="dimmed">{dayjs(p.updated_at).format('MMM D, YYYY')}</Text>
            </Group>
          </UnstyledButton>
        ))}
        {pages.length === 0 && (
          <Text c="dimmed" size="sm" mt="md">
            No pages yet.{canWrite ? ' Click "New page" to start writing.' : ''}
          </Text>
        )}
      </Stack>

      <MembersModal space={space} opened={membersOpen} onClose={membersHandlers.close} />
      <TrashModal space={space} opened={trashOpen} onClose={trashHandlers.close} onChanged={load} />
      <SpaceSettingsModal
        space={space} opened={settingsOpen} onClose={settingsHandlers.close}
        onSaved={load} canDelete={isAdmin}
        onDeleted={() => { window.dispatchEvent(new Event('spaces-changed')); navigate('/'); }}
      />
    </Container>
  );
}

function MembersModal({ space, opened, onClose }) {
  const [members, setMembers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [addUser, setAddUser] = useState(null);
  const [addRole, setAddRole] = useState('reader');

  const load = useCallback(async () => {
    const d = await api.get(`/api/spaces/${space.id}/members`);
    setMembers(d.members);
    const u = await api.get('/api/users');
    setAllUsers(u.users);
  }, [space.id]);

  useEffect(() => { if (opened) load(); }, [opened, load]);

  const nonMembers = allUsers.filter((u) => !members.some((m) => m.user_id === u.id));

  return (
    <Modal opened={opened} onClose={onClose} title={`Members of ${space.name}`} size="lg">
      <Group mb="md" align="flex-end">
        <Select
          label="Add user" placeholder="Pick a user" searchable style={{ flex: 1 }}
          data={nonMembers.map((u) => ({ value: u.id, label: `${u.name} (@${u.username})` }))}
          value={addUser} onChange={setAddUser}
        />
        <Select
          label="Role" w={130}
          data={[
            { value: 'reader', label: 'Can view' },
            { value: 'writer', label: 'Can edit' },
            { value: 'admin', label: 'Full access' },
          ]}
          value={addRole} onChange={setAddRole}
        />
        <Button
          disabled={!addUser}
          onClick={async () => {
            await api.post(`/api/spaces/${space.id}/members`, { userId: addUser, role: addRole });
            setAddUser(null);
            load();
          }}
        >
          Add
        </Button>
      </Group>
      <Table>
        <Table.Thead>
          <Table.Tr><Table.Th>User</Table.Th><Table.Th>Role</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {members.map((m) => (
            <Table.Tr key={m.user_id}>
              <Table.Td>{m.name} <Text span c="dimmed" size="xs">@{m.username}</Text></Table.Td>
              <Table.Td>
                <Select
                  size="xs" w={130}
                  data={[
                    { value: 'reader', label: 'Can view' },
                    { value: 'writer', label: 'Can edit' },
                    { value: 'admin', label: 'Full access' },
                  ]}
                  value={m.role}
                  onChange={async (role) => {
                    await api.patch(`/api/spaces/${space.id}/members/${m.user_id}`, { role });
                    load();
                  }}
                />
              </Table.Td>
              <Table.Td>
                <ActionIcon variant="subtle" color="red" size="sm"
                  onClick={async () => {
                    await api.del(`/api/spaces/${space.id}/members/${m.user_id}`);
                    load();
                  }}>
                  <IconX size={14} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" mt="sm">
        Workspace owners and admins always have full access to every space.
      </Text>
    </Modal>
  );
}

function TrashModal({ space, opened, onClose, onChanged }) {
  const [items, setItems] = useState([]);
  const load = useCallback(async () => {
    const d = await api.get(`/api/spaces/${space.id}/trash`);
    setItems(d.pages);
  }, [space.id]);
  useEffect(() => { if (opened) load(); }, [opened, load]);

  const act = async (fn) => { await fn(); load(); onChanged(); emitPagesChanged(space.id); };

  return (
    <Modal opened={opened} onClose={onClose} title="Trash" size="md">
      <Stack gap={4}>
        {items.length === 0 && <Text c="dimmed" size="sm">Trash is empty.</Text>}
        {items.map((p) => (
          <Group key={p.id} justify="space-between" wrap="nowrap" className="gd-page-row">
            <Text size="sm" truncate>{p.icon} {p.title || 'Untitled'}</Text>
            <Group gap={4} wrap="nowrap">
              <Text size="xs" c="dimmed">{dayjs(p.deleted_at).fromNow?.() || ''}</Text>
              <Tooltip label="Restore">
                <ActionIcon size="sm" variant="subtle" onClick={() => act(() => api.post(`/api/pages/${p.id}/restore`))}>
                  <IconRestore size={14} />
                </ActionIcon>
              </Tooltip>
              {space.my_role === 'admin' && (
                <Tooltip label="Delete forever">
                  <ActionIcon size="sm" variant="subtle" color="red"
                    onClick={() => window.confirm('Delete forever? This cannot be undone.') &&
                      act(() => api.del(`/api/pages/${p.id}/permanent`))}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Group>
        ))}
      </Stack>
    </Modal>
  );
}

function SpaceSettingsModal({ space, opened, onClose, onSaved, canDelete, onDeleted }) {
  const [form, setForm] = useState({ name: space.name, icon: space.icon, description: space.description });
  useEffect(() => {
    setForm({ name: space.name, icon: space.icon, description: space.description });
  }, [space, opened]);

  return (
    <Modal opened={opened} onClose={onClose} title="Space settings">
      <Stack>
        <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextInput label="Icon (emoji)" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} />
        <TextInput label="Description" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Button
          onClick={async () => {
            await api.patch(`/api/spaces/${space.id}`, form);
            window.dispatchEvent(new Event('spaces-changed'));
            onSaved();
            onClose();
          }}
        >
          Save
        </Button>
        {canDelete && (
          <Button
            color="red" variant="light"
            onClick={async () => {
              if (!window.confirm(`Delete space "${space.name}" and ALL its pages? This cannot be undone.`)) return;
              await api.del(`/api/spaces/${space.id}`);
              onDeleted();
            }}
          >
            Delete this space
          </Button>
        )}
      </Stack>
    </Modal>
  );
}
