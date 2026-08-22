// The origin check is the only thing standing between "an admin pasted a
// string" and "this server made an HTTP request to an address of the string's
// choosing". These tests are about that boundary, not about importing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicOrigin, validateSnapshot } from '../src/lib/spaceImport.js';
import { SNAPSHOT_VERSION } from '../src/lib/spaceTransfer.js';

const rejects = async (origin, pattern) => {
  await assert.rejects(() => assertPublicOrigin(origin), pattern);
};

test.beforeEach(() => {
  delete process.env.SPACE_IMPORT_ALLOW_PRIVATE_HOSTS;
});

test('cloud metadata is refused', async () => {
  // The reason this check exists: an unauthenticated endpoint serving instance
  // credentials to anything that can make an outbound request.
  await rejects('http://169.254.169.254', /private address/);
  await rejects('http://[::ffff:169.254.169.254]', /private address/);
});

test('loopback is refused', async () => {
  await rejects('http://127.0.0.1:3000', /private address/);
  await rejects('http://127.1.2.3', /private address/);
  await rejects('http://[::1]:3000', /private address/);
});

test('RFC1918 ranges are refused', async () => {
  await rejects('http://10.0.0.5', /private address/);
  await rejects('http://172.16.4.1', /private address/);
  await rejects('http://172.31.255.254', /private address/);
  await rejects('http://192.168.1.10', /private address/);
});

test('addresses just outside the private ranges are allowed', async () => {
  // 172.15 and 172.32 are public; only 172.16–172.31 is reserved. An overly
  // greedy check here would block real workspaces.
  await assert.doesNotReject(() => assertPublicOrigin('https://172.15.0.1'));
  await assert.doesNotReject(() => assertPublicOrigin('https://172.32.0.1'));
  await assert.doesNotReject(() => assertPublicOrigin('https://8.8.8.8'));
});

test('carrier-grade NAT and unique-local v6 are refused', async () => {
  await rejects('http://100.64.0.1', /private address/);
  await rejects('http://[fd00::1]', /private address/);
  await rejects('http://[fe80::1]', /private address/);
});

test('the opt-out lets a LAN workspace through', async () => {
  // Self-hosted workspaces really do sit beside each other on a private
  // network; the point is that it takes a deliberate server-side setting.
  process.env.SPACE_IMPORT_ALLOW_PRIVATE_HOSTS = 'true';
  await assert.doesNotReject(() => assertPublicOrigin('http://192.168.1.10:3000'));
  await assert.doesNotReject(() => assertPublicOrigin('http://127.0.0.1:3000'));
});

test('the opt-out is off unless it is spelled affirmatively', async () => {
  process.env.SPACE_IMPORT_ALLOW_PRIVATE_HOSTS = 'false';
  await rejects('http://192.168.1.10', /private address/);
  process.env.SPACE_IMPORT_ALLOW_PRIVATE_HOSTS = '0';
  await rejects('http://192.168.1.10', /private address/);
  process.env.SPACE_IMPORT_ALLOW_PRIVATE_HOSTS = '';
  await rejects('http://192.168.1.10', /private address/);
});

test('a hostname that does not resolve fails closed', async () => {
  await assert.rejects(
    () => assertPublicOrigin('https://this-host-does-not-exist.invalid'),
    /Could not reach/
  );
});

// ---- payload validation ----

const goodSnapshot = () => ({
  version: SNAPSHOT_VERSION,
  space: { name: 'Design', icon: '📐', description: '' },
  pages: [{ id: 'p1', parentId: null, title: 'Root', includeContent: true, content: {} }],
});

test('a well-formed snapshot passes through', () => {
  const snap = goodSnapshot();
  assert.equal(validateSnapshot(snap), snap);
});

test('a snapshot from another format version is refused before anything is written', () => {
  const snap = { ...goodSnapshot(), version: SNAPSHOT_VERSION + 1 };
  assert.throws(() => validateSnapshot(snap), /different version of Diomedes/);
});

test('an empty or malformed payload is refused', () => {
  assert.throws(() => validateSnapshot(null), /did not return a Diomedes export/);
  assert.throws(() => validateSnapshot('a string'), /did not return a Diomedes export/);
  assert.throws(() => validateSnapshot({ ...goodSnapshot(), pages: [] }), /contains no pages/);
  assert.throws(
    () => validateSnapshot({ ...goodSnapshot(), pages: [{ title: 'no id' }] }),
    /malformed export/
  );
});
