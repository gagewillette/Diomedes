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

function deliver({ userIds, ...payload }) {
  if (!clients.size) return;
  const targets = userIds?.length ? new Set(userIds) : null;
  const frame = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    if (targets && !targets.has(client.userId)) continue;
    try {
      client.res.write(frame);
    } catch {
      /* socket already gone; the close handler will clean it up */
    }
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

export function addClient(req, res) {
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

  const client = { userId: req.user.id, res };
  clients.add(client);

  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleaned up on close */
    }
  }, HEARTBEAT_MS);

  const close = () => {
    clearInterval(beat);
    clients.delete(client);
  };
  req.on('close', close);
  res.on('close', close);
}

const uniq = (ids) => [...new Set(ids.filter(Boolean))];

// Workspace owners/admins see every space and every user, so they are the
// audience for anything workspace-wide.
export async function adminAudience(extra = []) {
  const { rows } = await q(`SELECT id FROM users WHERE role IN ('owner', 'admin') AND active`);
  return uniq([...rows.map((r) => r.id), ...extra]);
}

// Everyone who can see a space: its members plus workspace admins.
export async function spaceAudience(spaceId, extra = []) {
  const { rows } = await q(
    `SELECT user_id AS id FROM space_members WHERE space_id = $1
     UNION
     SELECT id FROM users WHERE role IN ('owner', 'admin') AND active`,
    [spaceId]
  );
  return uniq([...rows.map((r) => r.id), ...extra]);
}
