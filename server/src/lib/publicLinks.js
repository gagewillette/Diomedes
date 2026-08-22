// Which pages a public share page links to, and which of those are public too.
//
// A guest reading a shared page has no session, so every in-page link into the
// wiki (`/s/<space>/p/<id>`) bounces them to the login screen — even when the
// target is shared just as publicly as the page they are already reading. The
// fix is to hand the guest, along with the document, the share tokens of the
// pages it links to, so the client can route those clicks to `/share/<token>`
// and keep the reader in the public domain.
//
// The mapping is derived from the document itself rather than served from a
// lookup endpoint on purpose: a share token is a capability, and this way a
// guest only ever learns the tokens of pages the page they already hold points
// at — never one guessed by id.
import { q } from '../db.js';
import { PAGE_LINK_NODE } from './links.js';

// Page ids are uuids, and the ids collected here go into a `uuid[]` parameter.
// Anything else in a stored href is a typo or someone probing, and either way
// it must not reach Postgres as a cast that throws.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// `/s/<slug>/p/<id>`, optionally with a query or `#heading` anchor after it.
const PAGE_HREF_RE = /^\/s\/[^/?#]+\/p\/([^/?#]+)/;

/** The page id an in-app href points at, or null for anything else. */
export function pageIdFromHref(href) {
  if (typeof href !== 'string') return null;
  const match = PAGE_HREF_RE.exec(href.trim());
  const id = match?.[1];
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * Every page id a document points at — both `pageLink` chips written by the
 * autocomplete and plain links whose href happens to be an in-app page path
 * (which is what a pasted URL and an imported document produce).
 */
export function extractLinkedPageIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;

  if (node.type === PAGE_LINK_NODE && node.attrs?.pageId && UUID_RE.test(node.attrs.pageId)) {
    out.add(node.attrs.pageId.toLowerCase());
  }
  for (const mark of node.marks || []) {
    if (mark?.type !== 'link') continue;
    const id = pageIdFromHref(mark.attrs?.href);
    if (id) out.add(id);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) extractLinkedPageIds(child, out);
  }
  return out;
}

/**
 * pageId -> share token, for the linked pages that are themselves shared.
 * Pages that are private, or in the trash, are simply absent: the client keeps
 * its existing behaviour for those, which is to send the guest to log in.
 */
export async function publicLinkTargets(doc) {
  const ids = [...extractLinkedPageIds(doc)];
  if (!ids.length) return {};
  const { rows } = await q(
    `SELECT id, share_token FROM pages
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND share_token IS NOT NULL`,
    [ids]
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.share_token]));
}
