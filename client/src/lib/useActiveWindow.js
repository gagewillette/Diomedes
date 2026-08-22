import { useCallback, useEffect, useRef, useState } from 'react';
import { claimWindow, heartbeatWindow, releaseWindow, windowId } from './activeWindow.js';

// Mirrors the server's default. The claim response carries the interval the
// server actually wants, which is picked up the next time the timer is set up
// — close enough for a value that only changes when the server is retuned.
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * Keeps this window's claim on the account.
 *
 * `status` is 'pending' until the first answer, then 'active' (this window owns
 * the account and the app is usable) or 'blocked' (another window owns it and
 * the overlay is shown). `takeOver()` is the Switch button.
 */
export function useActiveWindow(userId) {
  const [state, setState] = useState({ status: 'pending', holder: null, switching: false });
  const heartbeatMs = useRef(DEFAULT_HEARTBEAT_MS);
  // Read inside the interval and the unload handler, which are set up once and
  // must not be torn down every time the status changes.
  const statusRef = useRef('pending');
  statusRef.current = state.status;

  const apply = useCallback((result) => {
    if (result?.heartbeatMs) heartbeatMs.current = result.heartbeatMs;
    setState({
      status: result?.status === 'blocked' ? 'blocked' : 'active',
      holder: result?.status === 'blocked' ? result.holder || null : null,
      switching: false,
    });
  }, []);

  // First claim on sign-in. A failure here must not wall the user out of their
  // own account, so anything unexpected is treated as "you are active".
  useEffect(() => {
    if (!userId) {
      setState({ status: 'pending', holder: null, switching: false });
      return undefined;
    }
    let cancelled = false;
    claimWindow()
      .then((result) => !cancelled && apply(result))
      .catch(() => !cancelled && apply({ status: 'active' }));
    return () => {
      cancelled = true;
    };
  }, [userId, apply]);

  // Renew while we hold it. The interval also covers the case where the SSE
  // push announcing a takeover never arrived.
  useEffect(() => {
    if (!userId) return undefined;
    const tick = () => {
      if (statusRef.current !== 'active') return;
      heartbeatWindow()
        .then(apply)
        .catch(() => {
          /* transient: the next tick tries again */
        });
    };
    const timer = setInterval(tick, heartbeatMs.current);
    return () => clearInterval(timer);
  }, [userId, apply]);

  // Hand the claim back when the window goes away, so the next window does not
  // have to wait out the TTL. 'pagehide' fires on mobile Safari where 'unload'
  // does not.
  useEffect(() => {
    if (!userId) return undefined;
    const onLeave = () => {
      if (statusRef.current === 'active') releaseWindow();
    };
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      onLeave();
    };
  }, [userId]);

  // Pushed by the server whenever the claim moves. The payload names the
  // winner, so every window can tell from one broadcast whether it is now the
  // active one — and a window that just lost it asks for the holder's details.
  const onServerEvent = useCallback(
    (detail) => {
      if (detail?.clientId === windowId()) {
        setState({ status: 'active', holder: null, switching: false });
        return;
      }
      if (!detail?.clientId) {
        // Released with nobody holding it: claim it rather than sitting blocked
        // on a window that has closed.
        claimWindow().then(apply).catch(() => {});
        return;
      }
      heartbeatWindow()
        .then(apply)
        .catch(() => setState({ status: 'blocked', holder: null, switching: false }));
    },
    [apply]
  );

  const takeOver = useCallback(async () => {
    setState((s) => ({ ...s, switching: true }));
    try {
      apply(await claimWindow({ force: true }));
    } catch {
      setState((s) => ({ ...s, switching: false }));
    }
  }, [apply]);

  return { ...state, takeOver, onServerEvent };
}
