// WebSocket entry point for realtime page editing.
//
// Route: GET /api/collab/<pageId> (upgraded). Authentication reuses the express
// session middleware — the browser cannot attach an Authorization header to a
// WebSocket handshake, so the session cookie is the only credential available.
import { WebSocketServer } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as authProtocol from 'y-protocols/auth';
import { resolveUser, spaceRole, getPage } from '../lib/auth.js';
import { CollabHub, send } from './hub.js';
import {
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
} from './protocol.js';

const PING_INTERVAL_MS = 25_000;
// 4400-4499 tells the y-websocket client the failure is permanent and it should
// stop retrying; anything else is treated as transient.
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;

/** @type {CollabHub | null} */
let hub = null;
export const getHub = () => hub;

export async function attachCollab(httpServer, { redis, sessionMiddleware }) {
  hub = new CollabHub(redis);
  await hub.init();

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/api\/collab\/([0-9a-fA-F-]{36})$/);
    if (!match) return; // not ours: leave the socket for any other handler
    const pageId = match[1];

    // express-session is plain connect middleware, so it runs happily against
    // the raw upgrade request with a stub response.
    sessionMiddleware(req, {}, () => {
      authorize(req, pageId)
        .then((ctx) => {
          wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, pageId, ctx));
        })
        .catch((err) => {
          const status = err.status === 403 ? 403 : err.status === 404 ? 404 : 401;
          socket.write(`HTTP/1.1 ${status} ${err.message}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
        });
    });
  });

  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref?.();
  wss.on('close', () => clearInterval(pingInterval));

  return {
    wss,
    async close() {
      clearInterval(pingInterval);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await hub.destroy();
      hub = null;
    },
  };
}

async function authorize(req, pageId) {
  const user = await resolveUser(req);
  if (!user) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  const page = await getPage(pageId); // throws 404 when missing or trashed
  const role = await spaceRole(user, page.space_id);
  if (!role) throw Object.assign(new Error('Forbidden'), { status: 403 });
  return { user, page, role, canWrite: role === 'admin' || role === 'writer' };
}

async function onConnection(ws, pageId, ctx) {
  ws.binaryType = 'arraybuffer';
  ws.isAlive = true;
  // Awareness client ids seen on this socket, so its presence entries can be
  // cleared when it goes away.
  ws.collabClients = new Set();
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Opening a room hits the database, and the client starts its own sync
  // handshake the instant the socket opens. Buffer whatever arrives in the
  // meantime — a dropped sync step 1 leaves that client waiting forever for a
  // step 2 that is never sent.
  let room = null;
  const queued = [];

  const onMessage = (data) => {
    const frame = new Uint8Array(toArrayBuffer(data));
    if (!room) {
      queued.push(frame);
      return;
    }
    try {
      handleMessage(ws, room, ctx, frame);
    } catch (err) {
      console.error('collab: bad message', err.message);
    }
  };
  ws.on('message', onMessage);

  try {
    room = await hub.getRoom(pageId);
  } catch (err) {
    console.error('collab: failed to open room', pageId, err.message);
    ws.close(4500, 'room unavailable');
    return;
  }
  if (ws.readyState !== ws.OPEN) return; // client vanished while the room loaded

  room.addConn(ws);
  ws.on('close', () => room.removeConn(ws));
  ws.on('error', () => room.removeConn(ws));

  // Kick off the sync handshake from our side too, so a client that connects
  // with an empty doc still receives the current state without waiting.
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  send(ws, encoding.toUint8Array(encoder));

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
    );
    send(ws, encoding.toUint8Array(awarenessEncoder));
  }

  for (const frame of queued.splice(0)) {
    try {
      handleMessage(ws, room, ctx, frame);
    } catch (err) {
      console.error('collab: bad message', err.message);
    }
  }

  if (!ctx.canWrite) {
    // Advisory only — readers are also enforced below on every message.
    const authEncoder = encoding.createEncoder();
    encoding.writeVarUint(authEncoder, MESSAGE_AUTH);
    authProtocol.writePermissionDenied(authEncoder, 'read-only access to this space');
    send(ws, encoding.toUint8Array(authEncoder));
  }
}

function handleMessage(ws, room, ctx, buf) {
  const decoder = decoding.createDecoder(buf);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_SYNC: {
      // Never trust the client's own idea of its permissions: a reader may ask
      // for state (step 1) but any message that would mutate the doc is dropped.
      const peek = decoding.createDecoder(buf);
      decoding.readVarUint(peek);
      const syncType = decoding.readVarUint(peek);
      if (!ctx.canWrite && syncType !== syncProtocol.messageYjsSyncStep1) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // `ws` as the transaction origin is what keeps the update from being
      // echoed back to the socket that sent it.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
      if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
      break;
    }
    case MESSAGE_AWARENESS: {
      // Readers do get presence: seeing where someone is reading is harmless
      // and is half the point of the feature.
      const update = decoding.readVarUint8Array(decoder);
      trackAwarenessClients(ws, update);
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
      break;
    }
    case MESSAGE_QUERY_AWARENESS: {
      const states = room.awareness.getStates();
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
      );
      send(ws, encoding.toUint8Array(encoder));
      break;
    }
    default:
      break; // unknown message types are ignored rather than fatal
  }
}

// An awareness update starts with a count followed by (clientId, clock, state)
// triples. We only need the ids, to clean up after the socket closes.
function trackAwarenessClients(ws, update) {
  const decoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(decoder);
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder); // clock
    decoding.readVarString(decoder); // state json
    ws.collabClients.add(clientId);
  }
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return data; // Buffer / TypedArray — Uint8Array accepts both
}
