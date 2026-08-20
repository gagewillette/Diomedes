import { useEffect, useRef, useState } from 'react';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { syncCaretModes } from './carets.js';

// How long after the last keystroke someone still counts as "typing". Long
// enough to survive the pause between words, short enough that putting the
// keyboard down hands the spotlight back to the mouse pointer.
const TYPING_TTL_MS = 1400;
// Pointer updates are cheap but not free; ~20/s is smooth once the receiving
// side interpolates between them in CSS.
const POINTER_THROTTLE_MS = 50;

/**
 * Local presence broadcasting and the remote peer list.
 *
 * Two things are published, and which one a peer renders depends on what the
 * person is doing:
 *
 *  - `user.mode === 'typing'` — they are actively editing, so their text caret
 *    is the interesting thing. It carries the name label; their mouse pointer
 *    is hidden, because it is almost certainly parked somewhere irrelevant.
 *  - `user.mode === 'pointing'` — reading, scrolling, selecting or idle. Now the
 *    mouse pointer is what tells you where their attention is, so it is drawn
 *    Miro-style with the name attached and the caret drops back to a quiet tick
 *    (selection highlights stay visible either way).
 *
 * The pointer is stored in *content* coordinates — x as a fraction of the
 * editor width, y in pixels from the top of the document — not viewport
 * coordinates. Two people on different window sizes, scrolled to different
 * places, then still see each other's pointer against the same paragraph.
 */
/**
 * Everyone else currently on the page, newest awareness state first-come order.
 * Split out from usePresence so the page chrome can show an avatar bar without
 * owning the editor.
 */
export function usePeers(session) {
  const [peers, setPeers] = useState([]);
  const awareness = session?.provider?.awareness ?? null;

  useEffect(() => {
    if (!awareness) {
      setPeers([]);
      return undefined;
    }
    const read = () => {
      const next = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        if (!state?.user?.name) return;
        next.push({ clientId, user: state.user, pointer: state.pointer || null });
      });
      next.sort((a, b) => a.clientId - b.clientId);
      setPeers(next);
    };
    awareness.on('change', read);
    read();
    return () => awareness.off('change', read);
  }, [awareness]);

  return peers;
}

export function usePresence({ session, editor, me, wrapRef, canWrite }) {
  const peers = usePeers(session);
  const modeRef = useRef('pointing');
  const typingTimer = useRef(null);
  // Last known viewport position of the mouse, kept so the content-space
  // pointer can be recomputed while scrolling without any mouse movement.
  const lastClient = useRef(null);
  const lastSent = useRef(0);
  const scheduleRef = useRef({ timer: 0, raf: 0 });

  const awareness = session?.provider?.awareness ?? null;

  // ---- local identity ----
  useEffect(() => {
    if (!editor || !awareness || !me) return;
    setUser(editor, awareness, { ...me, mode: modeRef.current, canWrite });
  }, [editor, awareness, me, canWrite]);

  // ---- typing detection ----
  useEffect(() => {
    if (!editor || !awareness || !me) return undefined;

    const setMode = (mode) => {
      if (modeRef.current === mode) return;
      modeRef.current = mode;
      setUser(editor, awareness, { ...me, mode, canWrite });
    };

    const onTransaction = ({ transaction }) => {
      // `isChangeOrigin` is true for changes that arrived over the wire; only a
      // genuinely local edit means *this* person is typing.
      if (!transaction.docChanged || isChangeOrigin(transaction)) return;
      setMode('typing');
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setMode('pointing'), TYPING_TTL_MS);
    };

    const onBlur = () => {
      clearTimeout(typingTimer.current);
      setMode('pointing');
    };

    editor.on('transaction', onTransaction);
    editor.on('blur', onBlur);
    return () => {
      clearTimeout(typingTimer.current);
      editor.off('transaction', onTransaction);
      editor.off('blur', onBlur);
    };
  }, [editor, awareness, me, canWrite]);

  // ---- keep rendered carets in step with each peer's mode ----
  useEffect(() => {
    syncCaretModes(wrapRef.current, peers);
  }, [peers, wrapRef]);

  // ---- pointer tracking ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !awareness) return undefined;

    const pending = scheduleRef.current;

    const clearPointer = () => {
      lastClient.current = null;
      awareness.setLocalStateField('pointer', null);
    };

    const publish = () => {
      pending.raf = 0;
      const client = lastClient.current;
      if (!client) return;
      const rect = wrap.getBoundingClientRect();
      if (!rect.width) return;
      const x = (client.x - rect.left) / rect.width;
      const y = client.y - rect.top;
      // A little slack past the text column keeps the pointer alive in the
      // margins, where people park the mouse while reading.
      if (x < -0.25 || x > 1.25) {
        clearPointer();
        return;
      }
      awareness.setLocalStateField('pointer', { x, y });
      lastSent.current = Date.now();
    };

    const schedule = () => {
      if (pending.timer || pending.raf) return;
      const wait = Math.max(0, POINTER_THROTTLE_MS - (Date.now() - lastSent.current));
      if (wait) {
        pending.timer = setTimeout(() => {
          pending.timer = 0;
          pending.raf = requestAnimationFrame(publish);
        }, wait);
      } else {
        pending.raf = requestAnimationFrame(publish);
      }
    };

    const onMove = (event) => {
      lastClient.current = { x: event.clientX, y: event.clientY };
      schedule();
    };

    // Scrolling moves the document under a stationary mouse, so the pointer's
    // position *in the document* changes even though the mouse did not.
    const onScrollOrResize = () => {
      if (lastClient.current) schedule();
    };

    wrap.addEventListener('mousemove', onMove);
    wrap.addEventListener('mouseleave', clearPointer);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      clearTimeout(pending.timer);
      cancelAnimationFrame(pending.raf);
      pending.timer = 0;
      pending.raf = 0;
      wrap.removeEventListener('mousemove', onMove);
      wrap.removeEventListener('mouseleave', clearPointer);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [awareness, wrapRef]);

  return peers;
}

// The cursor extension owns the `user` awareness field, so go through its
// command when it is loaded and fall back to awareness directly when it is not
// (read-only viewers still broadcast presence).
function setUser(editor, awareness, user) {
  if (editor.commands.updateUser) editor.commands.updateUser(user);
  else awareness.setLocalStateField('user', user);
}
