import { useEffect, useState } from 'react';
import { Center, Paper, TextInput, PasswordInput, Button, Title, Text, Stack, Alert } from '@mantine/core';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('Diomedes');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();

  useEffect(() => {
    api.get('/api/auth/status', { noRedirect: true }).then((d) => {
      if (d.needsSetup) navigate('/setup', { replace: true });
      setWorkspaceName(d.workspaceName);
    }).catch(() => {});
  }, [navigate]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { username, password }, { noRedirect: true });
      await refresh();
      navigate(params.get('from') || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center h="100vh" bg="var(--mantine-color-body)">
      <Paper withBorder shadow="md" p="xl" w={380}>
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={2}>📝 {workspaceName}</Title>
              <Text c="dimmed" size="sm">Log in to your workspace</Text>
            </div>
            {error && <Alert color="red" p="xs">{error}</Alert>}
            <TextInput label="Username" value={username} onChange={(e) => setUsername(e.target.value)}
              autoFocus autoComplete="username" />
            <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" />
            <Button type="submit" loading={busy} disabled={!username || !password}>Log in</Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
