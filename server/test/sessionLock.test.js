import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, heartbeat, release, readClaim, initSessionLock } from '../src/lib/sessionLock.js';

// Enough of node-redis for the lock: get/set/del over a Map. TTLs are recorded
// but never expire on their own — expiry is simulated by deleting the key.
function fakeRedis() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async del(key) {
      store.delete(key);
    },
    expire: (key) => store.delete(key), // stand-in for "the TTL ran out"
  };
}

let redis;
test.beforeEach(() => {
  redis = fakeRedis();
  initSessionLock(redis);
});

test('the first window to ask gets the account', async () => {
  assert.deepEqual(await claim('u1', 'win-a'), { status: 'active' });
  assert.equal((await readClaim('u1')).clientId, 'win-a');
});

test('a second window is blocked and told where the account is open', async () => {
  await claim('u1', 'win-a', { label: 'Chrome on macOS' });
  const result = await claim('u1', 'win-b');
  assert.equal(result.status, 'blocked');
  assert.equal(result.holder.label, 'Chrome on macOS');
  // The holder's client id must never leak: knowing it would let the blocked
  // window pass itself off as the holder.
  assert.equal(result.holder.clientId, undefined);
  assert.equal((await readClaim('u1')).clientId, 'win-a', 'the holder keeps it');
});

test('re-claiming from the window that already holds it is a no-op', async () => {
  await claim('u1', 'win-a');
  const { since } = await readClaim('u1');
  assert.deepEqual(await claim('u1', 'win-a'), { status: 'active' });
  assert.equal((await readClaim('u1')).since, since, 'active-since does not creep forward');
});

test('force takes the account over', async () => {
  await claim('u1', 'win-a');
  assert.deepEqual(await claim('u1', 'win-b', { force: true, label: 'Firefox' }), {
    status: 'active',
  });
  const held = await readClaim('u1');
  assert.equal(held.clientId, 'win-b');
  assert.equal(held.label, 'Firefox', 'the new holder is described, not the old one');
});

test('the window that was taken over is blocked on its next heartbeat', async () => {
  await claim('u1', 'win-a');
  await claim('u1', 'win-b', { force: true });
  const result = await heartbeat('u1', 'win-a');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(await heartbeat('u1', 'win-b'), { status: 'active' });
  assert.equal((await readClaim('u1')).clientId, 'win-b', 'a stale heartbeat steals nothing');
});

test('an expired claim is picked up by whichever window asks next', async () => {
  await claim('u1', 'win-a');
  redis.expire('diomedes:active-window:u1');
  assert.deepEqual(await heartbeat('u1', 'win-b'), { status: 'active' });
  assert.equal((await readClaim('u1')).clientId, 'win-b');
});

test('release frees the account, but only for the window holding it', async () => {
  await claim('u1', 'win-a');
  await release('u1', 'win-b');
  assert.equal((await readClaim('u1')).clientId, 'win-a', 'a non-holder cannot release it');
  await release('u1', 'win-a');
  assert.equal(await readClaim('u1'), null);
  assert.deepEqual(await claim('u1', 'win-b'), { status: 'active' });
});

test('accounts are locked independently of one another', async () => {
  await claim('u1', 'win-a');
  assert.deepEqual(await claim('u2', 'win-b'), { status: 'active' });
});

test('with no redis configured nobody is ever locked out', async () => {
  initSessionLock(null);
  assert.deepEqual(await claim('u1', 'win-a'), { status: 'active' });
  assert.deepEqual(await claim('u1', 'win-b'), { status: 'active' });
  assert.deepEqual(await heartbeat('u1', 'win-b'), { status: 'active' });
});
