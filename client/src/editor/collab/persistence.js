import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';

// Delay before the elected writer pushes a JSON snapshot. Long enough that a
// burst of typing collapses into one write, short enough that a crash loses
// only a couple of seconds of *derived* state (the CRDT itself is already safe
// on the server).
const SNAPSHOT_DEBOUNCE_MS = 2500;

// A little longer than the server's seed lease (SEED_LEASE_SEC in
// server/src/routes/pages.js): how long a client that was refused the claim
// waits before deciding the holder is not coming back.
const SEED_RETRY_MS = 16_000;

const isEmptyDoc = (doc) =>
  !doc ||
  !Array.isArray(doc.content) ||
  doc.content.length === 0 ||
  (doc.content.length === 1 &&
    doc.content[0].type === 'paragraph' &&
    !doc.content[0].content?.length);

/**
 * Did the seed actually reach the collaborative document?
 *
 * Reporting a seed is what retires the page's one and only claim, so the answer
 * has to come from the document rather than from having called setContent a
 * moment ago. An editor torn down mid-seed — a page switch, a closed tab — has
 * left nothing behind, and saying otherwise strands the page empty for good.
 */
export const seedLanded = (editor, ydoc) =>
  Boolean(
    editor &&
      !editor.isDestroyed &&
      ydoc &&
      !ydoc.isDestroyed &&
      ydoc.getXmlFragment('default').length > 0
  );

/**
 * Convert the page's stored JSON into the CRDT, once, on first ever open.
 *
 * The conversion is a normal insert as far as Yjs is concerned, so two clients
 * doing it concurrently produces a document containing the page twice. The
 * server hands out the right to do it (see /collab/claim-seed); everyone else
 * simply waits for the resulting update to sync to them.
 */
export function useSeedContent({ session, editor, pageId, initialContent, canWrite }) {
  const attempted = useRef(false);
  const retry = useRef(null);
  // Bumped when a refused claim is worth looking at again; the effect below
  // reads it only to be re-run.
  const [round, setRound] = useState(0);
  const synced = session?.synced;
  const ydoc = session?.ydoc;

  useEffect(() => {
    if (!synced || !ydoc || !editor || !canWrite || attempted.current) return;
    attempted.current = true;

    if (ydoc.getXmlFragment('default').length > 0) return; // already seeded
    if (isEmptyDoc(initialContent)) return; // nothing worth seeding

    (async () => {
      try {
        const { granted, content } = await api.post(`/api/pages/${pageId}/collab/claim-seed`);
        if (editor.isDestroyed) return;
        if (!granted) {
          // Someone else holds the claim. Usually they finish and their update
          // syncs here, which the guard above then sees. But a client that took
          // the claim and died still holds it until the lease runs out, and
          // this is the only code that will ever fill the CRDT — so look again
          // once it has, rather than leaving the page blank for good.
          attempted.current = false;
          retry.current = setTimeout(() => setRound((n) => n + 1), SEED_RETRY_MS);
          return;
        }
        // Re-check: the grant is asynchronous, and the winner's update may have
        // landed while this request was in flight.
        if (ydoc.getXmlFragment('default').length > 0) return;
        editor.commands.setContent(content ?? initialContent, false);
        if (!seedLanded(editor, ydoc)) return; // let the lease expire instead
        await api.post(`/api/pages/${pageId}/collab/confirm-seed`);
      } catch {
        // A failed seed is recoverable: the claim lease expires and the next
        // client to open the page tries again.
        attempted.current = false;
      }
    })();
  }, [synced, ydoc, editor, pageId, initialContent, canWrite, round]);

  useEffect(() => () => clearTimeout(retry.current), []);
}

/**
 * Keep pages.content in step with the live document.
 *
 * The CRDT is the source of truth while people are editing, but the rest of
 * Diomedes — search indexing, version history, markdown export, the public
 * share view, the API — reads the JSON column. Rather than teach the server to
 * understand the editor schema, exactly one connected client writes the JSON
 * back.
 *
 * "Exactly one" is decided from the awareness state: the writer with the lowest
 * Yjs client id snapshots. Every client computes the same answer from the same
 * data, so the role transfers by itself when that person leaves — no election
 * protocol, and no window where nobody is saving.
 */
export function useContentSnapshot({ session, editor, pageId, canWrite, onSaveState, initialContent }) {
  const timer = useRef(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  // Whether this session has ever seen the live document hold anything. Until
  // it has, an empty CRDT means "the content has not arrived yet", not "the
  // page was emptied" — see the guard in save().
  const everFilled = useRef(false);

  // Deliberately keyed on ydoc/provider rather than the session object: the
  // session's identity changes whenever the connection status does, and
  // re-running this effect would cancel the pending snapshot timer every time.
  const ydoc = session?.ydoc ?? null;
  const provider = session?.provider ?? null;

  useEffect(() => {
    if (!ydoc || !provider || !editor || !canWrite) return undefined;

    const amLeader = () => {
      let lowest = provider.awareness.clientID;
      provider.awareness.getStates().forEach((state, clientId) => {
        if (state?.user?.canWrite && clientId < lowest) lowest = clientId;
      });
      return lowest === provider.awareness.clientID;
    };

    const save = async () => {
      if (!dirty.current || saving.current || editor.isDestroyed) return;
      // Someone else is responsible right now. Stay dirty: if they disconnect
      // before saving, the next change re-arms this timer under new leadership.
      if (!amLeader()) return;
      // Never let a document that has been blank all along overwrite a page
      // that has content stored. That happens when seeding did not run — the
      // claim went to a client that died, or the page was marked seeded before
      // its text ever reached the CRDT — and the empty editor would otherwise
      // persist itself over the real body. Emptying a page you can actually see
      // still saves: by then the document has been non-empty at least once.
      const json = editor.getJSON();
      if (isEmptyDoc(json) && !everFilled.current && !isEmptyDoc(initialContent)) {
        onSaveState?.('saved');
        return;
      }
      dirty.current = false;
      saving.current = true;
      onSaveState?.('saving');
      try {
        await api.patch(`/api/pages/${pageId}`, { content: json });
        onSaveState?.('saved');
      } catch {
        dirty.current = true;
        onSaveState?.('error');
      } finally {
        saving.current = false;
      }
    };

    // Every change counts, local or remote: the leader is the only writer, so
    // it has to persist other people's edits too.
    const onUpdate = () => {
      dirty.current = true;
      if (!everFilled.current && !editor.isDestroyed && !isEmptyDoc(editor.getJSON())) {
        everFilled.current = true;
      }
      if (amLeader()) onSaveState?.('saving');
      clearTimeout(timer.current);
      timer.current = setTimeout(save, SNAPSHOT_DEBOUNCE_MS);
    };
    ydoc.on('update', onUpdate);

    return () => {
      ydoc.off('update', onUpdate);
      clearTimeout(timer.current);
      // Closing the page is the one moment worth saving without waiting.
      if (dirty.current && !editor.isDestroyed && amLeader()) {
        const json = editor.getJSON();
        dirty.current = false;
        if (!isEmptyDoc(json) || everFilled.current || isEmptyDoc(initialContent)) {
          api.patch(`/api/pages/${pageId}`, { content: json }).catch(() => {});
        }
      }
    };
  }, [ydoc, provider, editor, pageId, canWrite, onSaveState, initialContent]);
}
