import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { addClient, publish } from '../src/lib/events.js';

// Minimal stand-ins for the express req/res pair an SSE handler is given.
function fakeConnection(userId) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const frames = [];
  req.user = { id: userId };
  req.socket = { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} };
  res.writeHead = () => res;
  res.flushHeaders = () => {};
  res.write = (chunk) => frames.push(chunk);
  addClient(req, res);
  frames.length = 0; // drop the initial retry hint
  return {
    events: () =>
      frames
        .filter((f) => f.startsWith('event:'))
        .map((f) => JSON.parse(f.match(/\ndata: (.*)\n/)[1])),
    close: () => req.emit('close'),
  };
}

test('an event with userIds reaches only those users', () => {
  const alice = fakeConnection('alice');
  const bob = fakeConnection('bob');
  try {
    publish({ type: 'account-changed', userIds: ['alice'] });
    assert.deepEqual(alice.events(), [{ type: 'account-changed' }]);
    assert.deepEqual(bob.events(), []);
  } finally {
    alice.close();
    bob.close();
  }
});

test('an event with no userIds reaches everyone', () => {
  const alice = fakeConnection('alice');
  const bob = fakeConnection('bob');
  try {
    publish({ type: 'spaces-changed' });
    assert.equal(alice.events().length, 1);
    assert.equal(bob.events().length, 1);
  } finally {
    alice.close();
    bob.close();
  }
});

test('payload fields ride along but userIds is not leaked to the browser', () => {
  const alice = fakeConnection('alice');
  try {
    publish({ type: 'space-members-changed', spaceId: 's1', userId: 'alice', userIds: ['alice', 'bob'] });
    assert.deepEqual(alice.events(), [{ type: 'space-members-changed', spaceId: 's1', userId: 'alice' }]);
  } finally {
    alice.close();
  }
});

test('every one of a user’s tabs gets the event, and closed ones stop receiving', () => {
  const tabOne = fakeConnection('alice');
  const tabTwo = fakeConnection('alice');
  try {
    publish({ type: 'account-changed', userIds: ['alice'] });
    assert.equal(tabOne.events().length, 1);
    assert.equal(tabTwo.events().length, 1);

    tabTwo.close();
    publish({ type: 'account-changed', userIds: ['alice'] });
    assert.equal(tabOne.events().length, 2);
    assert.equal(tabTwo.events().length, 1);
  } finally {
    tabOne.close();
  }
});
