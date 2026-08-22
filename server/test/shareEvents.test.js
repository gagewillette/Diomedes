import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { addClient, addPublicClient, publish } from '../src/lib/events.js';

// Stand-ins for the express req/res pair an SSE handler is given. The signed-in
// one mirrors events.test.js; the public one is the guest reading /share/:token,
// who has no session and so is identified by that token alone.
function connection(register) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const frames = [];
  req.socket = { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} };
  res.writeHead = () => res;
  res.flushHeaders = () => {};
  res.write = (chunk) => frames.push(chunk);
  register(req, res);
  frames.length = 0; // drop the initial retry hint
  return {
    events: () =>
      frames
        .filter((f) => f.startsWith('event:'))
        .map((f) => JSON.parse(f.match(/\ndata: (.*)\n/)[1])),
    close: () => req.emit('close'),
  };
}

const asUser = (userId) =>
  connection((req, res) => {
    req.user = { id: userId };
    addClient(req, res);
  });

const asGuest = (token) => connection((req, res) => addPublicClient(req, res, token));

test('a share event reaches only the guests holding that token', () => {
  const mine = asGuest('tok-a');
  const other = asGuest('tok-b');
  try {
    publish({ type: 'page-share-changed', pageId: 'p1', shared: false, tokens: ['tok-a'] });
    assert.deepEqual(mine.events(), [{ type: 'page-share-changed', pageId: 'p1', shared: false }]);
    assert.deepEqual(other.events(), []);
  } finally {
    mine.close();
    other.close();
  }
});

// The signed-in fan-out reads "no audience" as "everyone". For guests that
// default would push every workspace event to every open share page, so the
// rule is inverted: nothing reaches a guest unless it names their token.
test('an event without tokens reaches no guest at all', () => {
  const guest = asGuest('tok-a');
  try {
    publish({ type: 'spaces-changed' });
    publish({ type: 'account-changed', userIds: ['alice'] });
    assert.deepEqual(guest.events(), []);
  } finally {
    guest.close();
  }
});

test('the token list is routing, and never reaches the wire', () => {
  const guest = asGuest('tok-a');
  const alice = asUser('alice');
  try {
    publish({
      type: 'page-share-changed',
      pageId: 'p1',
      shared: false,
      tokens: ['tok-a', 'tok-b'],
      userIds: ['alice'],
    });
    for (const frame of [...guest.events(), ...alice.events()]) {
      assert.equal(frame.tokens, undefined);
      assert.equal(frame.userIds, undefined);
    }
  } finally {
    guest.close();
    alice.close();
  }
});

// The two halves of the feature are one event: the editor's share switch and
// the guest's open page must never disagree about whether the link is live.
test('one revoke reaches the editor and the guest on the same publish', () => {
  const owner = asUser('alice');
  const guest = asGuest('tok-a');
  try {
    publish({ type: 'page-share-changed', pageId: 'p1', shared: false, tokens: ['tok-a'], userIds: ['alice'] });
    assert.equal(owner.events().length, 1);
    assert.equal(guest.events().length, 1);
  } finally {
    owner.close();
    guest.close();
  }
});

test('a guest who closed the tab stops receiving', () => {
  const guest = asGuest('tok-a');
  publish({ type: 'page-share-changed', shared: false, tokens: ['tok-a'] });
  assert.equal(guest.events().length, 1);
  guest.close();
  publish({ type: 'page-share-changed', shared: true, tokens: ['tok-a'] });
  assert.equal(guest.events().length, 1);
});
