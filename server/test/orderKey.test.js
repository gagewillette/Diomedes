import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_62_DIGITS,
  generateKeyBetween,
  generateNKeysBetween,
  initialKeys,
  isOrderKey,
  keyForSlot,
  validateOrderKey,
} from '../src/lib/orderKey.js';

// Byte-order comparison, matching `text COLLATE "C"` in postgres. Using
// JavaScript's default `<` on strings is already codepoint order, so these
// assertions are the same comparison the database will make.
const lt = (a, b) => a < b;

test('the first key in an empty list is valid', () => {
  const key = generateKeyBetween(null, null);
  validateOrderKey(key);
  assert.equal(key, 'a0');
});

test('appending and prepending keep the list ordered', () => {
  const mid = generateKeyBetween(null, null);
  const after = generateKeyBetween(mid, null);
  const before = generateKeyBetween(null, mid);
  assert.ok(lt(before, mid), `${before} < ${mid}`);
  assert.ok(lt(mid, after), `${mid} < ${after}`);
});

test('a key between two neighbours sorts strictly between them', () => {
  const a = generateKeyBetween(null, null);
  const b = generateKeyBetween(a, null);
  const c = generateKeyBetween(a, b);
  assert.ok(lt(a, c) && lt(c, b));
});

// The whole reason this module exists. `position double precision` collapses
// here after ~50 iterations; a string index must not collapse ever.
test('a thousand drops into the same gap never collide', () => {
  let lo = generateKeyBetween(null, null);
  const hi = generateKeyBetween(lo, null);
  const seen = new Set([lo, hi]);
  for (let i = 0; i < 1000; i++) {
    const next = generateKeyBetween(lo, hi);
    assert.ok(lt(lo, next) && lt(next, hi), `collapsed at drop ${i}: ${lo} / ${next} / ${hi}`);
    assert.ok(!seen.has(next), `duplicate key at drop ${i}: ${next}`);
    seen.add(next);
    lo = next;
  }
});

test('repeatedly prepending never runs out of room', () => {
  let key = generateKeyBetween(null, null);
  for (let i = 0; i < 500; i++) {
    const next = generateKeyBetween(null, key);
    assert.ok(lt(next, key), `prepend collapsed at ${i}`);
    key = next;
  }
});

test('repeatedly appending never runs out of room', () => {
  let key = generateKeyBetween(null, null);
  for (let i = 0; i < 500; i++) {
    const next = generateKeyBetween(key, null);
    assert.ok(lt(key, next), `append collapsed at ${i}`);
    key = next;
  }
});

test('n keys between two bounds come back ascending and in range', () => {
  const a = generateKeyBetween(null, null);
  const b = generateKeyBetween(a, null);
  const keys = generateNKeysBetween(a, b, 25);
  assert.equal(keys.length, 25);
  for (let i = 0; i < keys.length; i++) {
    validateOrderKey(keys[i]);
    assert.ok(lt(a, keys[i]) && lt(keys[i], b));
    if (i) assert.ok(lt(keys[i - 1], keys[i]), `not ascending at ${i}`);
  }
});

// Bisection rather than chaining is what keeps these short; a chained
// implementation would produce a key per item with a tail as long as the list.
test('numbering a fresh list produces short keys', () => {
  const keys = initialKeys(200);
  assert.equal(keys.length, 200);
  for (let i = 1; i < keys.length; i++) assert.ok(lt(keys[i - 1], keys[i]));
  assert.ok(Math.max(...keys.map((k) => k.length)) <= 6, `keys grew to ${Math.max(...keys.map((k) => k.length))}`);
});

test('unbounded ends produce ascending runs', () => {
  const after = generateNKeysBetween(generateKeyBetween(null, null), null, 10);
  for (let i = 1; i < after.length; i++) assert.ok(lt(after[i - 1], after[i]));
  const before = generateNKeysBetween(null, generateKeyBetween(null, null), 10);
  for (let i = 1; i < before.length; i++) assert.ok(lt(before[i - 1], before[i]));
});

test('n <= 0 is an empty list, not an error', () => {
  assert.deepEqual(generateNKeysBetween(null, null, 0), []);
  assert.deepEqual(generateNKeysBetween(null, null, -3), []);
});

test('the digit set is ASCII-ascending, which is what makes COLLATE "C" work', () => {
  for (let i = 1; i < BASE_62_DIGITS.length; i++) {
    assert.ok(BASE_62_DIGITS[i - 1] < BASE_62_DIGITS[i]);
  }
});

test('a reversed range is rejected rather than silently producing nonsense', () => {
  const a = generateKeyBetween(null, null);
  const b = generateKeyBetween(a, null);
  assert.throws(() => generateKeyBetween(b, a));
  assert.throws(() => generateKeyBetween(a, a));
});

test('malformed keys are rejected', () => {
  assert.ok(!isOrderKey(''));
  assert.ok(!isOrderKey('!!'));
  assert.ok(!isOrderKey('a'), 'integer part shorter than its length code');
  assert.ok(!isOrderKey('a00'), 'trailing zero has no canonical form');
  assert.ok(!isOrderKey(null));
  assert.ok(isOrderKey('a0'));
});

// ---- keyForSlot: the drag-and-drop entry point ----

const list = (...keys) => keys.map((order_key, i) => ({ id: `p${i}`, order_key }));

test('dropping into an empty list produces the first key', () => {
  validateOrderKey(keyForSlot([], 0));
});

test('dropping at the top sorts before everything', () => {
  const items = list('a1', 'a2', 'a3');
  const key = keyForSlot(items, 0);
  assert.ok(lt(key, 'a1'));
});

test('dropping at the bottom sorts after everything', () => {
  const items = list('a1', 'a2', 'a3');
  const key = keyForSlot(items, items.length);
  assert.ok(lt('a3', key));
});

test('dropping in the middle sorts between the neighbours', () => {
  const items = list('a1', 'a2', 'a3');
  const key = keyForSlot(items, 2);
  assert.ok(lt('a2', key) && lt(key, 'a3'));
});

test('an index past either end is clamped rather than throwing', () => {
  const items = list('a1', 'a2');
  assert.ok(lt('a2', keyForSlot(items, 99)));
  assert.ok(lt(keyForSlot(items, -5), 'a1'));
});

// The float implementation needed a renumbering fallback for this case. This
// one has to simply keep working, drop after drop, into the same gap.
test('a hundred drops into the same slot of a real list stay ordered', () => {
  let items = list('a1', 'a2');
  for (let i = 0; i < 100; i++) {
    const key = keyForSlot(items, 1);
    assert.ok(lt(items[0].order_key, key) && lt(key, items[1].order_key), `collapsed at drop ${i}`);
    items = [items[0], { id: `new${i}`, order_key: key }, ...items.slice(1)];
  }
});
