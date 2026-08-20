// Scroll something into view and make it obvious where you landed.
//
// Written for footnotes, but deliberately not about footnotes: issue #29's
// section-sign cross-references (`§3.2`) need exactly this and nothing more —
// jump to an element in the same document, clear the sticky header, flash the
// destination so the eye finds it, and respect a reader who has asked for less
// motion. Both features want one behaviour, so both should call one function.
//
// `scrollIntoView` alone is not enough: the page topbar is `position: sticky`,
// so an element scrolled flush to the top of its container lands *underneath*
// it, and the reader arrives at a heading they cannot see.

/** The scroll container `el` actually moves inside, or null for the window. */
function scrollParent(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * How far to scroll so `targetTop` ends up `headerHeight + gap` below
 * `containerTop`.
 *
 * Pulled out as arithmetic so it can be tested without a layout engine.
 */
export function scrollDelta(targetTop, containerTop, headerHeight, gap = 12) {
  return targetTop - containerTop - headerHeight - gap;
}

/** Height of whatever is currently pinned over the top of the content. */
function stickyHeaderHeight() {
  const bar = document.querySelector('.gd-page-topbar');
  if (!bar) return 0;
  const { position } = getComputedStyle(bar);
  return position === 'sticky' || position === 'fixed' ? bar.getBoundingClientRect().height : 0;
}

export const prefersReducedMotion = () =>
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

/**
 * Bring `el` into view and flash it.
 *
 * `focus` moves keyboard focus to the destination as well, so a screen-reader
 * or keyboard user ends up where a sighted user is looking rather than back at
 * the link they just followed. It needs a tabindex the caller has already set,
 * or the element is focused programmatically and left untabbable — which is
 * what we want for a heading or a footnote body.
 */
export function scrollToElement(el, { flash = true, focus = true } = {}) {
  if (!el) return;
  const reduced = prefersReducedMotion();
  const behavior = reduced ? 'auto' : 'smooth';
  const container = scrollParent(el);
  const header = stickyHeaderHeight();

  if (container) {
    const delta = scrollDelta(el.getBoundingClientRect().top, container.getBoundingClientRect().top, header);
    container.scrollBy({ top: delta, behavior });
  } else {
    window.scrollBy({ top: scrollDelta(el.getBoundingClientRect().top, 0, header), behavior });
  }

  if (flash) {
    // Restarting the animation needs the class gone for a frame, or a second
    // click on the same reference flashes nothing at all.
    el.classList.remove('gd-scroll-flash');
    requestAnimationFrame(() => el.classList.add('gd-scroll-flash'));
    setTimeout(() => el.classList.remove('gd-scroll-flash'), 1200);
  }

  if (focus && typeof el.focus === 'function') {
    // preventScroll: the scroll above already put it where we want it, and
    // letting focus scroll again would fight the smooth animation.
    el.focus({ preventScroll: true });
  }
}
