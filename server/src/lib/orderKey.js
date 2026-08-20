// Base-62 fractional indexing — order keys that can always be split.
//
// An order key is a string that sorts between its neighbours by plain byte
// comparison, so inserting between two rows writes exactly one row and never
// renumbers the list. This replaces `position double precision`, which looks
// like it does the same thing but does not: a double has a 52-bit mantissa, so
// repeatedly halving the same gap runs out of representable midpoints after
// ~50 drops and the next one lands *on top of* its neighbour. A string has no
// such limit — it just grows a character.
//
// The encoding is the well-established Implab/Figma scheme (the one the
// `fractional-indexing` package implements), with a base-62 digit set:
//
//   key := integerPart fractionalPart
//
// The integer part's first character encodes its own length, which is what
// makes keys of different magnitudes still compare correctly as plain strings:
// 'a'..'z' mean positive integers of length 2..27, 'A'..'Z' mean negative ones.
// The fractional part is an unbounded run of digits with no trailing zero, so
// every key has exactly one representation and midpoints are unambiguous.
//
// IMPORTANT — collation. The digit set is ASCII-ascending ('0'<'9'<'A'<'Z'<
// 'a'<'z') and the whole scheme depends on comparisons matching that order.
// A default en_US.UTF-8 postgres collation does *not*: it sorts case-
// insensitively, so 'a' lands between 'A' and 'B' and the ordering silently
// scrambles. Every order-key column must therefore be declared
// `text COLLATE "C"`. See ORDER_KEY in db.js.

export const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 'A' is the shortest-sorting head, and its length code is 27.
const SMALLEST_INTEGER = 'A' + '0'.repeat(26);

/** The length an integer part must have, read from its head character. */
function integerLength(head) {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function validateInteger(int) {
  if (int.length !== integerLength(int[0])) throw new Error(`invalid integer part of order key: ${int}`);
}

function integerPart(key) {
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

/** Throw unless `key` is something this module could itself have produced. */
export function validateOrderKey(key, digits = BASE_62_DIGITS) {
  if (typeof key !== 'string' || !key.length) throw new Error(`invalid order key: ${key}`);
  if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
  const int = integerPart(key);
  const frac = key.slice(int.length);
  for (const ch of key.slice(1)) {
    if (digits.indexOf(ch) === -1) throw new Error(`invalid order key digit: ${ch}`);
  }
  if (frac.slice(-1) === digits[0]) throw new Error(`invalid order key (trailing zero): ${key}`);
}

/** True when `key` is a well-formed order key — the non-throwing form. */
export function isOrderKey(key) {
  try {
    validateOrderKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shortest fractional string strictly between `a` and `b`, where both are
 * fractional parts (no integer head) and `b` may be null meaning "unbounded".
 */
function midpoint(a, b, digits) {
  const zero = digits[0];
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === zero || (b !== null && b.slice(-1) === zero)) {
    throw new Error('trailing zero in fractional part');
  }
  if (b !== null) {
    // Everything the two share is carried through untouched; only the first
    // differing digit needs a decision.
    let n = 0;
    while ((a[n] || zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b !== null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) return digits[Math.round(0.5 * (digitA + digitB))];
  // Consecutive digits: there is no room at this position, so descend.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return digits[digitA] + midpoint(a.slice(1), null, digits);
}

function incrementInteger(x, digits) {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) digs[i] = digits[0];
    else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a' + digits[0];
  if (head === 'z') return null; // out of magnitudes
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digs.push(digits[0]);
  else digs.pop();
  return next + digs.join('');
}

function decrementInteger(x, digits) {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = digits.slice(-1);
    else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + digits.slice(-1);
  if (head === 'A') return null; // out of magnitudes
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < 'Z') digs.push(digits.slice(-1));
  else digs.pop();
  return next + digs.join('');
}

/**
 * A key that sorts strictly between `a` and `b`. Pass null for either end to
 * mean "nothing there" — `generateKeyBetween(null, null)` is the first key in
 * an empty list, `(last, null)` appends, `(null, first)` prepends.
 */
export function generateKeyBetween(a, b, digits = BASE_62_DIGITS) {
  if (a !== null && a !== undefined) validateOrderKey(a, digits);
  else a = null;
  if (b !== null && b !== undefined) validateOrderKey(b, digits);
  else b = null;
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return 'a' + digits[0];
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb, digits);
    if (ib < b) return ib;
    const res = decrementInteger(ib, digits);
    if (res === null) throw new Error('cannot decrement any more');
    return res;
  }

  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const next = incrementInteger(ia, digits);
    return next === null ? ia + midpoint(fa, null, digits) : next;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb, digits);
  const next = incrementInteger(ia, digits);
  if (next === null) throw new Error('cannot increment any more');
  if (next < b) return next;
  return ia + midpoint(fa, null, digits);
}

/**
 * `n` keys in ascending order, all strictly between `a` and `b`.
 *
 * Splitting the gap by bisection rather than chaining midpoints keeps the keys
 * short: numbering a fresh 200-block document this way produces keys of a few
 * characters instead of a 200-character tail.
 */
export function generateNKeysBetween(a, b, n, digits = BASE_62_DIGITS) {
  if (n <= 0) return [];
  if (n === 1) return [generateKeyBetween(a, b, digits)];
  if (b === null || b === undefined) {
    let c = generateKeyBetween(a, null, digits);
    const out = [c];
    for (let i = 1; i < n; i++) {
      c = generateKeyBetween(c, null, digits);
      out.push(c);
    }
    return out;
  }
  if (a === null || a === undefined) {
    let c = generateKeyBetween(null, b, digits);
    const out = [c];
    for (let i = 1; i < n; i++) {
      c = generateKeyBetween(null, c, digits);
      out.push(c);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b, digits);
  return [
    ...generateNKeysBetween(a, c, mid, digits),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1, digits),
  ];
}

/** Keys for a brand-new list of `n` items. */
export const initialKeys = (n) => generateNKeysBetween(null, null, n);

/**
 * Where to place an item dropped at `index` among `siblings`.
 *
 * `siblings` is the destination list *without* the item being moved, in order;
 * `index` is the slot it should occupy afterwards. Unlike the float version
 * this replaces, there is no `needsRenumber` escape hatch — the answer always
 * exists, which is the entire point of the encoding.
 */
export function keyForSlot(siblings, index, keyOf = (s) => s.order_key) {
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? keyOf(siblings[at - 1]) : null;
  const after = at < siblings.length ? keyOf(siblings[at]) : null;
  return generateKeyBetween(before, after);
}
