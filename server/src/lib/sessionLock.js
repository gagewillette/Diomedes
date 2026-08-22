// One active window per user account.
//
// A second browser window under the same account shares the same session
// cookie, so the session itself cannot tell the two apart. What we lock is
// therefore the *window*: every tab mints its own client id (sessionStorage,
// which a new window does not inherit) and one of them holds the claim.
//
// The claim lives in Redis under a short TTL and is renewed by a heartbeat, so
// a window that is closed or crashes releases the account on its own — the
// next window to ask simply finds an expired key and takes it.
import { publish } from './events.js';

// Long enough to ride out a missed heartbeat or a slow tab wake-up, short
// enough that a crashed window does not lock the account out for long.
export const CLAIM_TTL_SECONDS = 45;
export const HEARTBEAT_MS = 15_000;

const key = (userId) => `diomedes:active-window:${userId}`;

let client = null;
export function initSessionLock(redis) {
  client = redis;
}

const parse = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// What the browser needs to render either the app or the "already open
// elsewhere" screen. The holder's client id is never sent on: another window
// knowing it could claim to be that window.
const activeResult = () => ({ status: 'active' });
const blockedResult = (holder) => ({
  status: 'blocked',
  holder: { label: holder.label || null, since: holder.since || null },
});

export async function readClaim(userId) {
  if (!client) return null;
  return parse(await client.get(key(userId)));
}

async function writeClaim(userId, claim) {
  await client.set(key(userId), JSON.stringify(claim), { EX: CLAIM_TTL_SECONDS });
}

// Tell every window this user has open who holds the account now. Each one
// compares the id against its own and shows the app or the overlay; no
// per-window addressing is needed because the payload names the winner.
function announce(userId, clientId) {
  publish({ type: 'active-window-changed', userIds: [userId], clientId });
}

/**
 * Ask for the account. Returns `{ status: 'active' }` when this window may use
 * it, or `{ status: 'blocked', holder }` when another window has it and the
 * caller did not force a takeover.
 */
export async function claim(userId, clientId, { force = false, label = null } = {}) {
  if (!client) return activeResult(); // no redis configured: never lock anyone out
  const current = await readClaim(userId);

  if (current && current.clientId !== clientId && !force) return blockedResult(current);

  const takingOver = Boolean(current && current.clientId !== clientId);
  await writeClaim(userId, {
    clientId,
    label: label || (takingOver ? null : current?.label) || null,
    // Keep the original timestamp while the same window renews, so the
    // "active since" other windows see does not creep forward.
    since: takingOver || !current ? Date.now() : current.since || Date.now(),
  });
  if (takingOver || !current) announce(userId, clientId);
  return activeResult();
}

/**
 * Renew an existing claim. A window that is no longer the holder is told so
 * rather than silently stealing the account back — the SSE push normally beats
 * the heartbeat to it, but this covers a window that missed the event.
 */
export async function heartbeat(userId, clientId, { label = null } = {}) {
  if (!client) return activeResult();
  const current = await readClaim(userId);
  if (!current) {
    // The claim expired (no window renewed it). Whoever asks first gets it.
    await writeClaim(userId, { clientId, label, since: Date.now() });
    announce(userId, clientId);
    return activeResult();
  }
  if (current.clientId !== clientId) return blockedResult(current);
  await writeClaim(userId, current);
  return activeResult();
}

// Closing a window (or logging out) hands the account back immediately instead
// of making the next window wait out the TTL.
export async function release(userId, clientId) {
  if (!client) return;
  const current = await readClaim(userId);
  if (!current || current.clientId !== clientId) return;
  await client.del(key(userId));
  announce(userId, null);
}
