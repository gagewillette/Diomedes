// What a guest reading a publicly shared page is allowed to follow.
//
// The editor renders the same document for a signed-in member and for a guest
// on `/share/:token`, but a link means something different in the two cases. A
// member follows `/s/<space>/p/<id>` into the app. A guest has no session, so
// that path bounces them to the login screen — which is right for a private
// page and wrong for one shared just as publicly as the page they are already
// reading. The server sends the share tokens of the linked pages that are
// public (see server/src/lib/publicLinks.js); this module holds them where the
// link chip and the click handler — one React, one a ProseMirror plugin — can
// both ask the same question.
//
// Mutated rather than replaced for the same reason `linkContext` is: the
// plugins close over this exact object, built once per editor session.
export const publicShareContext = {
  // The token of the page being read, or null when this is not a share view.
  token: null,
  // pageId -> share token, for the linked pages that are public too.
  links: {},
};

/** Called by SharePage as it renders; `links` may be undefined on older payloads. */
export function setPublicShareView(token, links) {
  publicShareContext.token = token || null;
  publicShareContext.links = links || {};
}

export function clearPublicShareView() {
  publicShareContext.token = null;
  publicShareContext.links = {};
}

/** True while the app is showing a page by share token rather than by login. */
export const inPublicShareView = () => Boolean(publicShareContext.token);

/**
 * Where a guest should be sent for `pageId`, or null when there is nowhere
 * public to send them — either this is not a share view, or that page is not
 * shared, in which case the caller keeps its normal behaviour and the login
 * screen does its job.
 *
 * `suffix` carries a `#heading` anchor or query string through from the href
 * that was clicked, so a link into a section of another public page still
 * lands on that section.
 */
export function publicShareHref(pageId, suffix = '') {
  if (!inPublicShareView() || !pageId) return null;
  const token = publicShareContext.links[pageId];
  return token ? `/share/${encodeURIComponent(token)}${suffix}` : null;
}

// `/s/<slug>/p/<id>`, with whatever query or anchor followed it. Mirrors
// `pageIdFromHref` on the server, which decides what to build the map from.
const PAGE_HREF_RE = /^\/s\/[^/?#]+\/p\/([^/?#]+)([?#].*)?$/;

/**
 * The public URL for an in-app page href, or null if it is not one, or its
 * target is not public. Lets the click handler swap a link's destination
 * without knowing anything about how pages are addressed.
 */
export function publicShareHrefFor(href) {
  if (typeof href !== 'string') return null;
  const match = PAGE_HREF_RE.exec(href.trim());
  if (!match) return null;
  return publicShareHref(match[1].toLowerCase(), match[2] || '');
}
