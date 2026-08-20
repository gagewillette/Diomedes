// Ranking for the emoji picker's search box, kept apart from the sprite sheet
// so it can be exercised without a bundler.

/**
 * Emoji from `list` whose name (`n`) or shortcodes (`k`) match every term in
 * `query`, best first. An empty query returns the list untouched, which is what
 * lets the picker show the whole grid in its natural category order.
 *
 * A term that starts a shortcode is the strongest signal — typing "hea" should
 * reach :heart: before "headphone" — then a term starting a word, then a term
 * buried anywhere. Ties keep the incoming order.
 */
export function rankEmoji(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const terms = q.split(/\s+/);
  const scored = [];
  for (const e of list) {
    let score = 0;
    for (const term of terms) {
      const inName = e.n.indexOf(term);
      const inKeys = e.k.indexOf(term);
      if (inName < 0 && inKeys < 0) {
        score = -1;
        break;
      }
      if (inKeys === 0 || e.n.startsWith(term)) score += 3;
      else if (/[\s_-]/.test(e.k[inKeys - 1] || '') || /[\s-]/.test(e.n[inName - 1] || '')) score += 2;
      else score += 1;
    }
    if (score > 0) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, e]) => e);
}

/** Strip variation selectors, which the sheet keys without. */
export function normalizeEmoji(char) {
  return char.replace(/\uFE0F/g, '');
}
