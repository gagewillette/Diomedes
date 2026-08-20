// In-memory Yjs rooms, one per page.
//
// A room is the authoritative copy of a page's CRDT document while at least one
// client is connected. It fans updates out to local sockets, mirrors them to
// other app processes over Redis pub/sub, and periodically flushes the encoded
// document to postgres so nothing depends on a process staying alive.
//
// Yjs updates are commutative and idempotent, which is what makes the Redis
// mirror safe: a duplicated or out-of-order delivery cannot corrupt the doc, so
// the relay needs no ordering guarantees and no per-client revision bookkeeping.
// See docs/realtime-collaboration.md for why that beats OT here.
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { q } from '../db.js';

const FLUSH_DEBOUNCE_MS = 2000;
const FLUSH_MAX_DELAY_MS = 10_000;
// How long a room lingers after the last client leaves. Reopening a page is
// common enough that immediate teardown would mean a pointless DB round trip.
const EMPTY_ROOM_TTL_MS = 30_000;

// Housekeeping timers should never be the reason a process refuses to exit;
// shutdown flushes and tears rooms down explicitly.
const unref = (timer) => {
  timer.unref?.();
  return timer;
};

export class Room {
  constructor(pageId, hub) {
    this.pageId = pageId;
    this.hub = hub;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server is not a participant
    /** @type {Set<import('ws').WebSocket>} */
    this.conns = new Set();
    this.dirtySince = 0;
    this.flushTimer = null;
    this.evictTimer = null;
    this.destroyed = false;
    // Serialises flushes so two overlapping writes cannot land out of order.
    this.flushChain = Promise.resolve();

    this.doc.on('update', (update, origin) => {
      this.broadcastUpdate(update, origin);
      this.markDirty();
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (changed.length) this.broadcastAwareness(changed, origin);
    });
  }

  async load() {
    const { rows } = await q('SELECT state FROM page_ydoc WHERE page_id = $1', [this.pageId]);
    if (rows[0]?.state) Y.applyUpdate(this.doc, new Uint8Array(rows[0].state), 'db');
  }

  // ---- fan-out ----

  broadcastUpdate(update, origin) {
    this.hub.onDocUpdate(this, update, origin);
  }

  broadcastAwareness(changedClients, origin) {
    this.hub.onAwarenessUpdate(this, changedClients, origin);
  }

  // Apply an update that arrived from another app process. The `'redis'` origin
  // stops the hub from echoing it straight back out.
  applyRemoteUpdate(update) {
    Y.applyUpdate(this.doc, update, 'redis');
  }

  applyRemoteAwareness(update) {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, 'redis');
  }

  // ---- persistence ----

  markDirty() {
    if (this.destroyed) return;
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    if (now - this.dirtySince >= FLUSH_MAX_DELAY_MS) {
      this.flush();
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = unref(setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS));
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirtySince) return this.flushChain;
    this.dirtySince = 0;
    const state = Buffer.from(Y.encodeStateAsUpdate(this.doc));
    this.flushChain = this.flushChain
      .then(() =>
        q(
          `INSERT INTO page_ydoc (page_id, state, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (page_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [this.pageId, state]
        )
      )
      .catch((err) => console.error(`collab: flush failed for page ${this.pageId}:`, err.message));
    return this.flushChain;
  }

  // ---- lifecycle ----

  addConn(ws) {
    clearTimeout(this.evictTimer);
    this.evictTimer = null;
    this.conns.add(ws);
  }

  removeConn(ws) {
    this.conns.delete(ws);
    const clientIds = [...this.awareness.getStates().keys()].filter((id) => ws.collabClients?.has(id));
    if (clientIds.length) awarenessProtocol.removeAwarenessStates(this.awareness, clientIds, null);
    if (this.conns.size === 0) this.scheduleEviction();
  }

  scheduleEviction() {
    clearTimeout(this.evictTimer);
    this.evictTimer = unref(
      setTimeout(() => {
        if (this.conns.size > 0) return;
        this.hub.evict(this);
      }, EMPTY_ROOM_TTL_MS)
    );
  }

  // Kick every client, e.g. after a version restore replaced the document
  // out from under them. Clients reconnect and resync from the reset state.
  closeAll(code, reason) {
    for (const ws of [...this.conns]) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    }
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.evictTimer);
    // Flush before tearing down: the doc is about to leave memory.
    await this.flush();
    await this.flushChain;
    this.awareness.destroy();
    this.doc.destroy();
  }
}
