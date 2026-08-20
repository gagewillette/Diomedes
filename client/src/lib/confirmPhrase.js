// A four-letter phrase the user has to retype before an irreversible action
// runs. The point is not secrecy — the code is right there on screen — it is
// that the phrase is different every time, so the gesture cannot be learned as
// muscle memory the way "click OK" can.

// No I and no O: at four monospaced characters they are read as 1 and 0 often
// enough to turn a confirmation into a typo hunt.
export const CONFIRM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CONFIRM_LENGTH = 4;

export function makeConfirmPhrase(length = CONFIRM_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CONFIRM_ALPHABET[b % CONFIRM_ALPHABET.length]).join('');
}

// Case and surrounding whitespace are typing accidents, not answers, so they do
// not count against the user.
export function confirmPhraseMatches(typed, phrase) {
  if (typeof typed !== 'string' || typeof phrase !== 'string' || !phrase) return false;
  return typed.trim().toUpperCase() === phrase.toUpperCase();
}
