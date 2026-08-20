// The non-performance half of the Workspace info panel: what is actually in
// this workspace, and how much room it takes up.
//
// Every figure here is workspace-wide and therefore owner/admin-only — a member
// is not supposed to learn how many spaces exist that they cannot see.
import fs from 'node:fs/promises';
import path from 'node:path';
import { q, pool, vectorAvailable } from '../db.js';
import { searchHealth } from '../search/index.js';
import { STORAGE_PATH } from '../routes/files.js';

/** Recursive size of a directory tree, in bytes. Missing tree reads as zero. */
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        /* deleted between readdir and stat */
      }
    }
  }
  return total;
}

async function counts() {
  const { rows } = await q(`
    SELECT
      (SELECT count(*) FROM users)::int                                        AS users,
      (SELECT count(*) FROM users WHERE active)::int                           AS active_users,
      (SELECT count(*) FROM users WHERE role IN ('owner','admin'))::int        AS admins,
      (SELECT count(*) FROM spaces)::int                                       AS spaces,
      (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int               AS pages,
      (SELECT count(*) FROM pages WHERE deleted_at IS NOT NULL)::int           AS trashed_pages,
      (SELECT count(*) FROM pages WHERE deleted_at IS NULL AND share_token IS NOT NULL)::int AS shared_pages,
      (SELECT count(*) FROM page_versions)::int                                AS versions,
      (SELECT count(*) FROM comments)::int                                     AS comments,
      (SELECT count(*) FROM comments WHERE NOT resolved)::int                  AS open_comments,
      (SELECT count(*) FROM attachments)::int                                  AS attachments,
      (SELECT coalesce(sum(size), 0) FROM attachments)::bigint                 AS attachment_bytes,
      (SELECT count(*) FROM api_tokens)::int                                   AS api_tokens,
      (SELECT count(*) FROM page_links)::int                                   AS page_links,
      (SELECT coalesce(sum(length(text_content)), 0) FROM pages WHERE deleted_at IS NULL)::bigint AS content_chars,
      (SELECT max(updated_at) FROM pages WHERE deleted_at IS NULL)             AS last_edit,
      (SELECT min(created_at) FROM users)                                      AS created_at
  `);
  return rows[0];
}

/** Per-table on-disk footprint, so an admin can see what is growing. */
async function tableSizes() {
  const { rows } = await q(`
    SELECT relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r'
    ORDER BY bytes DESC LIMIT 15
  `);
  return rows.map((r) => ({ name: r.name, bytes: Number(r.bytes) }));
}

async function activity() {
  const { rows } = await q(`
    SELECT
      (SELECT count(*) FROM pages WHERE deleted_at IS NULL AND created_at > now() - interval '7 days')::int  AS pages_7d,
      (SELECT count(*) FROM pages WHERE deleted_at IS NULL AND updated_at > now() - interval '7 days')::int  AS edits_7d,
      (SELECT count(*) FROM comments WHERE created_at > now() - interval '7 days')::int                      AS comments_7d,
      (SELECT count(*) FROM attachments WHERE created_at > now() - interval '7 days')::int                   AS uploads_7d,
      (SELECT count(*) FROM page_versions WHERE created_at > now() - interval '7 days')::int                 AS versions_7d
  `);
  return rows[0];
}

/** Space-by-space breakdown: the usual answer to "why is this install big". */
async function spaces() {
  const { rows } = await q(`
    SELECT s.id, s.name, s.slug, s.icon,
           count(p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS pages,
           (SELECT count(*) FROM space_members m WHERE m.space_id = s.id)::int AS members,
           (SELECT coalesce(sum(a.size), 0) FROM attachments a WHERE a.space_id = s.id)::bigint AS bytes,
           max(p.updated_at) FILTER (WHERE p.deleted_at IS NULL) AS last_edit
    FROM spaces s LEFT JOIN pages p ON p.space_id = s.id
    GROUP BY s.id ORDER BY pages DESC, s.name
  `);
  return rows.map((r) => ({ ...r, bytes: Number(r.bytes) }));
}

export async function workspaceInfo() {
  const [c, sizes, act, spaceRows, storageBytes, dbSize, search] = await Promise.all([
    counts(),
    tableSizes(),
    activity(),
    spaces(),
    dirSize(STORAGE_PATH),
    q('SELECT pg_database_size(current_database())::bigint AS bytes'),
    searchHealth().catch(() => null),
  ]);

  return {
    totals: {
      users: c.users,
      activeUsers: c.active_users,
      admins: c.admins,
      spaces: c.spaces,
      pages: c.pages,
      trashedPages: c.trashed_pages,
      sharedPages: c.shared_pages,
      versions: c.versions,
      comments: c.comments,
      openComments: c.open_comments,
      attachments: c.attachments,
      apiTokens: c.api_tokens,
      pageLinks: c.page_links,
      contentChars: Number(c.content_chars),
    },
    storage: {
      // Bytes recorded against attachment rows vs. what is actually on the
      // volume — a gap between the two means orphaned files.
      attachmentBytes: Number(c.attachment_bytes),
      diskBytes: storageBytes,
      databaseBytes: Number(dbSize.rows[0].bytes),
      tables: sizes,
    },
    activity: {
      pages7d: act.pages_7d,
      edits7d: act.edits_7d,
      comments7d: act.comments_7d,
      uploads7d: act.uploads_7d,
      versions7d: act.versions_7d,
      lastEdit: c.last_edit,
      createdAt: c.created_at,
    },
    spaces: spaceRows,
    runtime: {
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      // Only ever this one instance's memory; a multi-instance deploy answers
      // from whichever node served the request, which is stated in the UI.
      memory: process.memoryUsage(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      vectorAvailable,
      search,
    },
  };
}
