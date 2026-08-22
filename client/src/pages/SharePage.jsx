import { useCallback, useEffect, useState } from 'react';
import { Container, Title, Text, Center, Loader, Group, Divider } from '@mantine/core';
import { useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import Editor from '../editor/Editor.jsx';
import FindBar from '../components/FindBar.jsx';
import { useDocumentIdentity } from '../lib/documentTitle.js';
import { setPublicShareView, clearPublicShareView } from '../lib/publicShare.js';
import { startPublicRealtime } from '../lib/realtime.js';
import Emoji from '../components/Emoji.jsx';

export default function SharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
  const [findOpen, setFindOpen] = useState(false);

  const load = useCallback(() => {
    let live = true;
    api.get(`/api/public/${token}`, { noRedirect: true })
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
      })
      .catch((err) => {
        if (!live) return;
        // Whatever is on screen came from a link that no longer works, so it
        // goes away in the same breath as the reason why.
        setData(null);
        setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [token]);

  // Following a link from one shared page to another keeps this component
  // mounted, so the previous document — and the link map that came with it —
  // has to be dropped before the new one arrives.
  useEffect(() => {
    setData(null);
    setError(null);
    return load();
  }, [token, load]);

  // A share link is a live permission, not a snapshot taken when the page
  // loaded. Revoking it has to close this view where it already sits open, and
  // sharing the page again has to reopen it — a reader looking at a revoked
  // page should never have to guess when to try refreshing.
  useEffect(
    () =>
      startPublicRealtime(token, (type, detail) => {
        // 'reconnected' means events were missed while the stream was down, so
        // the current state has to be asked for rather than assumed.
        if (type === 'reconnected' || detail.shared) {
          load();
          return;
        }
        setData(null);
        setError('This link is invalid or has been revoked');
      }),
    [token, load]
  );

  // Links out of this document are resolved against the tokens the server sent
  // with it, so a link to another public page keeps the guest in the public
  // app instead of sending them to log in. Assigned during render, before the
  // editor below mounts and asks. See lib/publicShare.js.
  setPublicShareView(token, data?.publicLinks);
  useEffect(() => clearPublicShareView, []);

  // A shared link is a document too, so name the tab after it.
  useDocumentIdentity(data?.page.title, data?.page.icon);

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
