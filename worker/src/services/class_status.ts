import type { Env } from '../env'

/* CLASS STATUS: the school's switch, its rules, and the sweep that takes
   yesterday's posts away.

   module_settings module 'class_status' (enabled, config). Like student
   logins (services/student_logins.ts), a school that has never touched the
   switch gets it ON with the defaults below; nothing is written until an
   administrator chooses otherwise. config:
     needs_approval     posts by anyone who does not run Class Status wait for
                        the principal before anybody sees them
     who                teachers | class_teachers | admins: who may post
     allow_video        false: photos only
     max_video_seconds  5..60, default 30

   A post lives 24 hours from the moment it went live. Pinned posts stay, in
   the class gallery, until somebody unpins or deletes them. Everything else
   is deleted by the hourly 'status:expire' sweep, row and R2 object both
   (services/background/housekeeping.ts calls expireStatuses). A pending or
   rejected post nobody decided on goes the same way after 24 hours. */

export const MODULE = 'class_status'
export const LIFETIME_MS = 24 * 3600_000
export const MAX_BYTES = 25 << 20
export const WHO = ['teachers', 'class_teachers', 'admins'] as const
export type Who = (typeof WHO)[number]

export interface StatusPolicy {
  enabled: boolean
  needs_approval: boolean
  who: Who
  allow_video: boolean
  max_video_seconds: number
  chosen: boolean
}

export const DEFAULT_POLICY: StatusPolicy = { enabled: true, needs_approval: false, who: 'teachers', allow_video: true, max_video_seconds: 30, chosen: false }

export function cleanPolicy(raw: Record<string, unknown>, base: StatusPolicy = DEFAULT_POLICY): Omit<StatusPolicy, 'chosen'> {
  const secs = Number(raw.max_video_seconds)
  return {
    enabled: raw.enabled === undefined ? base.enabled : !!raw.enabled,
    needs_approval: raw.needs_approval === undefined ? base.needs_approval : !!raw.needs_approval,
    who: (WHO as readonly string[]).includes(String(raw.who)) ? (raw.who as Who) : base.who,
    allow_video: raw.allow_video === undefined ? base.allow_video : !!raw.allow_video,
    max_video_seconds: Number.isFinite(secs) && raw.max_video_seconds !== undefined ? Math.min(60, Math.max(5, Math.round(secs))) : base.max_video_seconds,
  }
}

export async function statusPolicy(db: D1Database): Promise<StatusPolicy> {
  const row = await db.prepare(`SELECT enabled, config FROM module_settings WHERE module = ?`).bind(MODULE)
    .first<{ enabled: number; config: string | null }>().catch(() => null)
  if (!row) return { ...DEFAULT_POLICY }
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(row.config || '{}') } catch { /* defaults */ }
  return { ...cleanPolicy({ ...cfg, enabled: !!row.enabled }), chosen: true }
}

export interface StatusSummary { enabled: boolean; live: number; pending: number }

/** A small figure for the principal's board (GET /status/summary, and the dashboard payload): live now, waiting for approval. */
export async function statusSummary(db: D1Database): Promise<StatusSummary> {
  const pol = await statusPolicy(db)
  if (!pol.enabled) return { enabled: false, live: 0, pending: 0 }
  const r = await db.prepare(`SELECT
      (SELECT count(*) FROM status_posts WHERE status = 'live' AND expires_at > ?) AS live,
      (SELECT count(*) FROM status_posts WHERE status = 'pending') AS pending`).bind(new Date().toISOString())
    .first<{ live: number; pending: number }>().catch(() => null)
  return { enabled: true, live: r?.live ?? 0, pending: r?.pending ?? 0 }
}

/* THE SCHOOL'S MEDIA ALLOWANCE (owner, 2026-10-05): 5 GB of status and
   gallery photos and videos. Nothing is said until it is nearly full (90%);
   at 100% a new post is refused. Counted from the rows: a row is deleted
   with its bytes, so what is listed is what is stored. */
export const MEDIA_QUOTA = 5 * 1024 ** 3
export async function mediaUsed(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM status_posts WHERE status <> 'rejected'`).first<{ n: number }>()
  return r?.n ?? 0
}
/** The warning, only once it is nearly full; undefined before that. */
export function storageWarning(used: number): string | undefined {
  if (used < MEDIA_QUOTA * 0.9) return undefined
  const gb = (used / 1024 ** 3).toFixed(1)
  return used >= MEDIA_QUOTA
    ? `Gallery storage is full (5 GB). Remove old gallery photos or videos to post new ones.`
    : `Gallery storage is almost full: ${gb} of 5 GB used.`
}

/** Deletes expired, unpinned posts and their R2 objects. Returns how many went. */
export async function expireStatuses(env: Pick<Env, 'FILES_WRITE'>, db: D1Database, at = new Date()): Promise<number> {
  const nowIso = at.toISOString()
  const dayAgo = new Date(at.getTime() - LIFETIME_MS).toISOString()
  let gone = 0
  for (;;) {
    const rows = (await db.prepare(`SELECT id, object_key, thumb_key FROM status_posts
        WHERE pinned = 0 AND ((status = 'live' AND expires_at <= ?) OR (status <> 'live' AND created_at <= ?))
        LIMIT 200`).bind(nowIso, dayAgo).all<{ id: string; object_key: string; thumb_key: string | null }>()).results ?? []
    if (!rows.length) break
    // The bytes first: a row left behind is retried next hour, an orphaned object never would be.
    const keys = rows.flatMap((r) => [r.object_key, r.thumb_key]).filter((k): k is string => !!k)
    if (keys.length) await env.FILES_WRITE.delete(keys)
    const ids = JSON.stringify(rows.map((r) => r.id))
    await db.batch([
      db.prepare(`DELETE FROM status_views WHERE post_id IN (SELECT value FROM json_each(?))`).bind(ids),
      db.prepare(`DELETE FROM status_post_targets WHERE post_id IN (SELECT value FROM json_each(?))`).bind(ids),
      db.prepare(`DELETE FROM status_posts WHERE id IN (SELECT value FROM json_each(?))`).bind(ids),
    ])
    gone += rows.length
    if (rows.length < 200) break
  }
  return gone
}
