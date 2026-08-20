// Room registry plus the cross-process bridge.
//
// A single app process could keep every room purely in memory, but Diomedes is
// deployed behind a load balancer often enough that two editors of the same page
// can land on different processes. Each room therefore subscribes to a Redis
// channel and republishes its local updates there; every process applies what it
// receives to its own copy of the doc. Messages carry the originating process id
// so a publisher ignores its own echo.
import crypto from 'node:crypto';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { Room } from './rooms.js';
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from './protocol.js';

const CHANNEL = (pageId) => `diomedes:collab:${pageId}`;

export class CollabHub {
  constructor(redis) {
    this.processId = crypto.randomUUID();
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, Promise<Room>>} */
    this.pending = new Map();
    this.redis = redis;
    this.sub = null;
  }

  async init() {
    // node-redis puts a connection into subscriber mode, so pub/sub needs its
    // own client separate from the one serving sessions and the search queue.
    this.sub = this.redis.duplicate();
    this.sub.on('error', (err) => console.error('collab redis error', err.message));
    await this.sub.connect();
  }

  // Rooms are created lazily and exactly once per page: concurrent connections
  // await the same in-flight promise rather than racing to build two docs.
  async getRoom(pageId) {
    const existing = this.rooms.get(pageId);
    if (existing) return existing;
    const inflight = this.pending.get(pageId);
    if (inflight) return inflight;

    const promise = (async () => {
      const room = new Room(pageId, this);
      await room.load();
      await this.sub.subscribe(CHANNEL(pageId), (message) => this.onRedisMessage(pageId, message));
      this.rooms.set(pageId, room);
      this.pending.delete(pageId);
      return room;
    })().catch((err) => {
      this.pending.delete(pageId);
      throw err;
    });
    this.pending.set(pageId, promise);
    return promise;
  }

  onRedisMessage(pageId, message) {
    const room = this.rooms.get(pageId);
    if (!room) return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (payload.from === this.processId) return;
    if (payload.kind === 'reset') {
      this.resetLocal(pageId);
      return;
    }
    const bytes = new Uint8Array(Buffer.from(payload.data, 'base64'));
    if (payload.kind === 'update') room.applyRemoteUpdate(bytes);
    else if (payload.kind === 'awareness') room.applyRemoteAwareness(bytes);
  }

  publish(pageId, kind, bytes) {
    this.redis
      .publish(
        CHANNEL(pageId),
        JSON.stringify({
          from: this.processId,
          kind,
          data: bytes ? Buffer.from(bytes).toString('base64') : null,
        })
      )
      .catch((err) => console.error('collab publish failed:', err.message));
  }

  // ---- callbacks from Room ----

  onDocUpdate(room, update, origin) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const frame = encoding.toUint8Array(encoder);
    // `origin` is the socket the update came in on; it already has this change.
    for (const ws of room.conns) if (ws !== origin) send(ws, frame);
    if (origin !== 'redis') this.publish(room.pageId, 'update', update);
  }

  onAwarenessUpdate(room, changedClients, origin) {
    const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changedClients);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const frame = encoding.toUint8Array(encoder);
    for (const ws of room.conns) if (ws !== origin) send(ws, frame);
    if (origin !== 'redis') this.publish(room.pageId, 'awareness', update);
  }

  // Release everything: used by graceful shutdown and by the tests, both of
  // which need the process to be able to exit.
  async destroy() {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    this.pending.clear();
    await Promise.all(rooms.map((room) => room.destroy()));
    if (this.sub?.isOpen) await this.sub.quit().catch(() => {});
  }

  async evict(room) {
    if (this.rooms.get(room.pageId) !== room) return;
    this.rooms.delete(room.pageId);
    await this.sub.unsubscribe(CHANNEL(room.pageId)).catch(() => {});
    await room.destroy();
  }

  // Drop a page's live document, e.g. after a version restore rewrote it.
  // Connected clients are closed with a transient code so they reconnect and
  // pull the fresh state. Every process holding the room has to do this, hence
  // the Redis notification alongside the local reset.
  async resetPage(pageId) {
    this.publish(pageId, 'reset', null);
    await this.resetLocal(pageId);
  }

  async resetLocal(pageId) {
    const room = this.rooms.get(pageId);
    if (!room) return;
    room.dirtySince = 0; // whatever is in memory is stale; do not write it back
    clearTimeout(room.flushTimer);
    room.closeAll(4500, 'document reset');
    await this.evict(room);
  }
}

export function send(ws, frame) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(frame);
  } catch {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}
