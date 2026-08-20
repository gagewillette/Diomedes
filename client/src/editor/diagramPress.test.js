import test from 'node:test';
import assert from 'node:assert/strict';
import { createPressTracker, DOUBLE_PRESS_MS } from './diagramPress.js';

const at = (time, x = 100, y = 100) => ({ x, y, time });

test('a lone press is a single press', () => {
  const presses = createPressTracker();
  assert.equal(presses.press(at(0)), 'single');
});

test('two quick presses in the same spot are a double press', () => {
  const presses = createPressTracker();
  assert.equal(presses.press(at(0)), 'single');
  assert.equal(presses.press(at(120)), 'double');
});

test('a third press starts a new pair rather than doubling again', () => {
  const presses = createPressTracker();
  presses.press(at(0));
  assert.equal(presses.press(at(120)), 'double');
  assert.equal(presses.press(at(200)), 'single');
});

test('presses too far apart in time stay single', () => {
  const presses = createPressTracker();
  presses.press(at(0));
  assert.equal(presses.press(at(DOUBLE_PRESS_MS + 1)), 'single');
});

test('presses too far apart on screen stay single', () => {
  const presses = createPressTracker();
  presses.press(at(0, 100, 100));
  assert.equal(presses.press(at(80, 140, 100)), 'single');
});

// The bug: on a page that is only a diagram, the click that brings the page
// back to the front lands on the diagram, and opened it.
test('the press that brings the page back does nothing', () => {
  const presses = createPressTracker();
  presses.press(at(0));
  presses.focusLost();
  assert.equal(presses.press(at(5000)), 'refocus');
});

test('the press after the one that brings the page back counts again', () => {
  const presses = createPressTracker();
  presses.focusLost();
  presses.press(at(5000));
  assert.equal(presses.press(at(5200)), 'single');
  assert.equal(presses.press(at(5300)), 'double');
});

// The browser's own click counter survives a focus change; ours must not, or a
// press from before the trip away could pair with the one that comes back.
test('a press before leaving cannot pair with one after', () => {
  const presses = createPressTracker();
  presses.press(at(0));
  presses.focusLost();
  presses.press(at(100)); // the press that brings the page back
  assert.equal(presses.press(at(200)), 'single');
});

test('reset drops a pending refocus as well as the last press', () => {
  const presses = createPressTracker();
  presses.press(at(0));
  presses.focusLost();
  presses.reset();
  assert.equal(presses.press(at(100)), 'single');
});
