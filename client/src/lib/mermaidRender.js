// The bookkeeping around a single `mermaid.render()` call.
//
// mermaid renders by appending a scratch element to the document, keyed off the
// id it was handed, and removing it again once it has an SVG. A diagram that
// fails to parse never gets that far, so the scratch element is left behind and
// the caller has to clear it — mermaid names it `d` + the render id.
//
// Doing that needs the id of *this* render, not "the last id handed out": every
// diagram on a page renders at once, so by the time a broken one throws, the
// counter has moved on to a diagram that is still rendering into its scratch
// element. Removing that one takes a perfectly good diagram down with the bad
// one, which is how a single unparseable fence blanks the whole page.

let counter = 0;

/** A render id no other in-flight render is using. */
export function nextRenderId() {
  counter += 1;
  return `gd-mermaid-${counter}`;
}

/** Drop the scratch element mermaid leaves behind when `render` throws. */
export function removeRenderScratch(id, root = typeof document === 'undefined' ? null : document) {
  if (!id || !root) return;
  root.getElementById(`d${id}`)?.remove();
}
