/**
 * What a press on a diagram means: nothing, view it, or edit it.
 *
 * Two things go wrong if you take the browser at its word here.
 *
 * The click that brings a page back to the front is delivered to whatever sits
 * under the pointer. On a page that is nothing but a diagram that is the
 * diagram itself, so clicking back into the tab threw the reader into the
 * full-screen diagram — as though they had asked to open it. The first press
 * after the page loses focus is a press that focuses the page, and that is all.
 *
 * `MouseEvent.detail`, the browser's own click counter, is no way to tell a
 * double press from a single one either: that counter belongs to the window and
 * keeps counting across a focus change, so the press that comes back can arrive
 * as click number two and read as a double press — the gesture that opens the
 * diagram editor. This tracker counts presses itself and forgets them the
 * moment the page loses focus, so a pair can never span a trip away.
 *
 * Positions are compared rather than elements: pressing a diagram makes
 * ProseMirror rebuild the node's DOM, so the second press of a real
 * double-click lands on a different element object.
 */

export const DOUBLE_PRESS_MS = 450;
export const DOUBLE_PRESS_SLOP_PX = 6;

export function createPressTracker({
  doublePressMs = DOUBLE_PRESS_MS,
  slopPx = DOUBLE_PRESS_SLOP_PX,
} = {}) {
  let last = null;
  let refocusing = false;

  return {
    /**
     * Record a press and say what it means:
     *   'refocus' — it only brought the page back; do nothing with it
     *   'double'  — it completes a double press
     *   'single'  — anything else
     */
    press({ x, y, time }) {
      if (refocusing) {
        refocusing = false;
        return 'refocus';
      }
      const isDouble =
        last !== null &&
        time - last.time <= doublePressMs &&
        Math.abs(x - last.x) <= slopPx &&
        Math.abs(y - last.y) <= slopPx;
      // Forgetting the pair keeps a third press from reading as another double.
      last = isDouble ? null : { x, y, time };
      return isDouble ? 'double' : 'single';
    },

    /** The page went away: the next press is the one that brings it back. */
    focusLost() {
      last = null;
      refocusing = true;
    },

    /** Forget everything — the next press starts fresh and counts. */
    reset() {
      last = null;
      refocusing = false;
    },
  };
}
