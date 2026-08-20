import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const wsOrigin = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/collab`;

/**
 * One Yjs document + websocket provider per page.
 *
 * The document is built synchronously so it can be handed straight to the
 * editor's extension list — TipTap binds to the shared type when the editor is
 * created and cannot be re-pointed afterwards, which is also why the Editor
 * component is keyed by page id.
 */
export function useCollabSession({ pageId, enabled, resetKey = 0 }) {
  const session = useMemo(() => {
    if (!enabled || !pageId) return null;
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(wsOrigin(), pageId, ydoc, {
      // Resync periodically: a dropped update on a flaky connection would
      // otherwise leave the two sides quietly diverged until the next reload.
      resyncInterval: 20_000,
    });
    return { ydoc, provider, pageId };
    // `resetKey` changes when the page's document is replaced wholesale (a
    // version restore). The server drops its copy, so this client must drop
    // its own too — reconnecting with the old Y.Doc would push the discarded
    // content straight back into the empty room.
  }, [pageId, enabled, resetKey]);

  const [status, setStatus] = useState('connecting');
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!session) return undefined;
    const { provider, ydoc } = session;
    const onStatus = ({ status: next }) => setStatus(next);
    const onSync = (isSynced) => setSynced(isSynced);
    // 4400-4499 means the server decided retrying is pointless (access revoked,
    // page deleted). Surface it instead of spinning on "connecting".
    const onClosed = () => setStatus('denied');
    provider.on('status', onStatus);
    provider.on('sync', onSync);
    provider.on('closed', onClosed);
    return () => {
      provider.off('status', onStatus);
      provider.off('sync', onSync);
      provider.off('closed', onClosed);
      provider.destroy();
      ydoc.destroy();
    };
  }, [session]);

  // Memoised so the identity only changes when the connection state actually
  // changes. Consumers still key their effects off session.ydoc / .provider,
  // which never change for the life of a session.
  return useMemo(
    () => (session ? { ...session, status, synced } : null),
    [session, status, synced]
  );
}
