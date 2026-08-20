import { useCallback, useEffect, useState } from 'react';
import {
  Container, Title, Table, Button, Group, Modal, TextInput, PasswordInput, Select,
  Badge, Menu, ActionIcon, Stack, Text,
} from '@mantine/core';
import { IconPlus, IconDots, IconKey, IconTrash, IconUserOff, IconUserCheck } from '@tabler/icons-react';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import { api, onAppEvent } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useDocumentIdentity } from '../lib/documentTitle.js';

export default function MembersAdmin() {
  const { user: me } = useAuth();
  useDocumentIdentity('Members', '👥');
  const [users, setUsers] = useState([]);
  const [createOpen, createHandlers] = useDisclosure(false);
  const [form, setForm] = useState({ username: '', name: '', password: '', role: 'member' });

  const load = useCallback(async () => {
    const d = await api.get('/api/users');
    setUsers(d.users);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onAppEvent('users-changed', load), [load]);

  const run = async (fn, successMsg) => {
    try {
      await fn();
      if (successMsg) notifications.show({ color: 'green', message: successMsg });
      load();
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const createUser = () =>
    run(async () => {
      await api.post('/api/users', form);
      createHandlers.close();
      setForm({ username: '', name: '', password: '', role: 'member' });
    }, 'User created');

  const roleBadge = (role) =>
    role === 'owner' ? <Badge color="grape" size="sm">Owner</Badge>
      : role === 'admin' ? <Badge color="blue" size="sm">Admin</Badge>
      : <Badge color="gray" size="sm" variant="light">Member</Badge>;

  return (
    <Container size="md" py="xl">
      <Group justify="space-between" mb="lg">
        <div>
          <Title order={2}>Users</Title>
          <Text c="dimmed" size="sm">
            Create accounts and control workspace roles. Give users access to specific spaces from each
            space's Members dialog.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={15} />} onClick={createHandlers.open}>New user</Button>
      </Group>

      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>User</Table.Th><Table.Th>Role</Table.Th><Table.Th>Status</Table.Th>
            <Table.Th>Created</Table.Th><Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {users.map((u) => (
            <Table.Tr key={u.id} opacity={u.active ? 1 : 0.5}>
              <Table.Td>
                <Text size="sm" fw={600}>{u.name}</Text>
                <Text size="xs" c="dimmed">@{u.username}</Text>
              </Table.Td>
              <Table.Td>
                {me.role === 'owner' && u.role !== 'owner' ? (
                  <Select
                    size="xs" w={110}
                    data={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]}
                    value={u.role}
                    onChange={(role) => role && run(() => api.patch(`/api/users/${u.id}`, { role }))}
                  />
                ) : roleBadge(u.role)}
              </Table.Td>
              <Table.Td>
                {u.active ? <Badge color="green" variant="light" size="sm">Active</Badge>
                  : <Badge color="red" variant="light" size="sm">Deactivated</Badge>}
              </Table.Td>
              <Table.Td><Text size="xs" c="dimmed">{dayjs(u.created_at).format('MMM D, YYYY')}</Text></Table.Td>
              <Table.Td>
                {u.role !== 'owner' && u.id !== me.id && (
                  <Menu withinPortal position="bottom-end" shadow="md">
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray"><IconDots size={15} /></ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconKey size={14} />}
                        onClick={() => {
                          const password = window.prompt(`New password for @${u.username} (min 8 chars)`);
                          if (password) run(() => api.patch(`/api/users/${u.id}`, { password }), 'Password reset');
                        }}
                      >
                        Reset password
                      </Menu.Item>
                      <Menu.Item
                        leftSection={u.active ? <IconUserOff size={14} /> : <IconUserCheck size={14} />}
                        onClick={() => run(() => api.patch(`/api/users/${u.id}`, { active: !u.active }))}
                      >
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red" leftSection={<IconTrash size={14} />}
                        onClick={() =>
                          window.confirm(`Delete @${u.username}? Their comments and authorship info will be removed.`) &&
                          run(() => api.del(`/api/users/${u.id}`), 'User deleted')}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Modal opened={createOpen} onClose={createHandlers.close} title="Create user">
        <Stack>
          <TextInput label="Username" description="They log in with this" value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })} data-autofocus />
          <TextInput label="Display name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <PasswordInput label="Password" description="At least 8 characters — share it with them securely"
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {me.role === 'owner' && (
            <Select
              label="Workspace role"
              description="Admins can manage users and all spaces. Members only see spaces they are added to."
              data={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]}
              value={form.role} onChange={(role) => setForm({ ...form, role })}
            />
          )}
          <Button onClick={createUser}
            disabled={!form.username || !form.name || form.password.length < 8}>
            Create user
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
