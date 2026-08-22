// Server-sent events: pushes "your access changed" signals to connected browsers
// so membership/role edits show up without a manual refresh.
//
// Every app instance keeps its own set of open responses and fans messages out
// over a Redis pub/sub channel, so a change made on one instance reaches
// browsers connected to any of them.
import { q } from '../db.js';

const CHANNEL = 'diomedes:events';
const HEARTBEAT_MS = 25_000;

const clients = new Set(); // { userId, res }
// Guests reading a shared page have no session, so they cannot join `clients`.
// They get their own set keyed by the share token they are viewing, which is
// the only identity a public reader has. See addPublicClient.
const publicClients = new Set(); // { token, res }
let publisher = null;

export function initEvents(redis) {
  publisher = redis;
  const sub = redis.duplicate();
  sub.on('error', (err) => console.error('redis events error', err.message));
  sub
    .connect()
    .then(() =>
      sub.subscribe(CHANNEL, (raw) => {
        try {
          deliver(JSON.parse(raw));
        } catch (err) {
          console.error('bad event payload', err.message);
        }
      })
    )
    .catch((err) => console.error('event subscriber failed', err.message));
}

function deliver({ userIds, tokens, ...payload }) {
  if (!clients.size && !publicClients.size) return;
  // `userIds` and `tokens` are routing, not content: they say who the event is
  // for and must never reach the wire — a public frame carrying the token list
  // would hand every guest the other pages' links.
  const frame = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const write = (res) => {
    try {
      res.write(frame);
    } catch {
      /* socket already gone; the close handler will clean it up */
    }
  };

  const targets = userIds?.length ? new Set(userIds) : null;
  for (const client of clients) {
    if (targets && !targets.has(client.userId)) continue;
    write(client.res);
  }

  // Unlike the signed-in fan-out, an event with no `tokens` reaches no guest at
  // all: public streams are opt-in per event, so nothing leaks by default.
  if (!tokens?.length) return;
  const publicTargets = new Set(tokens);
  for (const client of publicClients) {
    if (!publicTargets.has(client.token)) continue;
    write(client.res);
  }
}

// Fire-and-forget: an event that fails to publish must never fail the request
// that triggered it.
export function publish(event) {
  if (!publisher) return deliver(event);
  publisher.publish(CHANNEL, JSON.stringify(event)).catch((err) => {
    console.error('event publish failed', err.message);
    deliver(event); // at least reach the browsers on this instance
  });
}

// The wire setup every stream needs, whatever identity is on the other end.
// Returns a function that registers the caller's own teardown alongside the
// heartbeat's.
function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
  });
  res.flushHeaders?.();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.write('retry: 3000\n\n');

  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleaned up on close */
    }
  }, HEARTBEAT_MS);

  return (onClose) => {
    const close = () => {
      clearInterval(beat);
      onClose();
    };
    req.on('close', close);
    res.on('close', close);
  };
}

export function addClient(req, res) {
  const onClose = openStream(req, res);
  const client = { userId: req.user.id, res };
  clients.add(client);
  onClose(() => clients.delete(client));
}

// A guest viewing /share/:token. That token is the whole identity a public
// reader has, so it is what the stream is keyed by. A revoked token still gets
// a stream on purpose: that open connection is how the viewer finds out the
// page has been shared again.
export function addPublicClient(req, res, token) {
  const onClose = openStream(req, res);
  const client = { token, res };
  publicClients.add(client);
  onClose(() => publicClients.delete(client));
}

const uniq = (ids) => [...new Set(ids.filter(Boolean))];

// Workspace owners/admins see every space and every user, so they are the
// audience for anything workspace-wide.
export async function adminAudience(extra = []) {
  const { rows } = await q(`SELECT id FROM users WHERE role IN ('owner', 'admin') AND active`);
  return uniq([...rows.map((r) => r.id), ...extra]);
}

// Every active user. Used when a change is visible workspace-wide, such as a
// space opening up to (or closing off from) the public.
export async function everyoneAudience(extra = []) {
  const { rows } = await q(`SELECT id FROM users WHERE active`);
  return uniq([...rows.map((r) => r.id), ...extra]);
}

// Everyone who can see a space: its members plus workspace admins — and, when
// the space grants public access, every active user.
export async function spaceAudience(spaceId, extra = []) {
  const { rows } = await q(
    `SELECT user_id AS id FROM space_members WHERE space_id = $1
     UNION
     SELECT id FROM users WHERE role IN ('owner', 'admin') AND active
     UNION
     SELECT u.id FROM users u
     WHERE u.active AND EXISTS (SELECT 1 FROM spaces s WHERE s.id = $1 AND s.public_role IS NOT NULL)`,
    [spaceId]
  );
  return uniq([...rows.map((r) => r.id), ...extra]);
}
