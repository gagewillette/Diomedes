import { useEffect, useState } from 'react';
import { Center, Paper, TextInput, PasswordInput, Button, Title, Text, Stack, Alert } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';

export default function Setup() {
  const [form, setForm] = useState({ workspaceName: '', name: '', username: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { refresh } = useAuth();

  useEffect(() => {
    api.get('/api/auth/status', { noRedirect: true }).then((d) => {
      if (!d.needsSetup) navigate('/login', { replace: true });
    }).catch(() => {});
  }, [navigate]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/setup', form, { noRedirect: true });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center h="100vh" bg="var(--mantine-color-body)">
      <Paper withBorder shadow="md" p="xl" w={420}>
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={2}>Welcome to Diomedes</Title>
              <Text c="dimmed" size="sm">Set up your workspace and owner account</Text>
            </div>
            {error && <Alert color="red" p="xs">{error}</Alert>}
            <TextInput label="Workspace name" placeholder="Gage's Docs" value={form.workspaceName}
              onChange={set('workspaceName')} autoFocus />
            <TextInput label="Your name" placeholder="Gage" value={form.name} onChange={set('name')} />
            <TextInput label="Username" placeholder="gage" value={form.username} onChange={set('username')}
              description="Used to log in. Letters, numbers, . _ @ -" />
            <PasswordInput label="Password" value={form.password} onChange={set('password')}
              description="At least 8 characters" />
            <Button type="submit" loading={busy}
              disabled={!form.name || !form.username || form.password.length < 8}>
              Create workspace
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
