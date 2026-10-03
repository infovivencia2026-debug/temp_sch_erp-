/* Class Status (communication.class_status): a photo or a short video that a
   teacher, or the school itself, posts to one section, a whole class, the
   whole school or the staff, like a WhatsApp status. It is seen for 24 hours
   unless pinned to the class gallery (services/class_status.ts holds the
   switch, the rules and the expiry sweep).

   WHO SEES WHAT. A post is visible to its poster, to anyone who runs Class
   Status (status.manage), and to the people in one of its targets:
     school   every family, child and member of staff
     staff    staff only (posts as the school)
     class    families and children enrolled in the class; staff who teach
              one of its sections (class teacher, subject teacher, on the
              timetable) -- they are told, too (AUDIENCE_SQL)
     section  the same, for one section
   A video's length is read from the file's own movie header (services/
   video_meta.ts) and held to the school's maximum; the browser's figure
   counts only for a file that cannot be read that way.
   The bytes are in FILES_WRITE under class-status/<institution>/ and never
   public: GET /status/posts/{id}/media streams them (with Range, for video)
   only after that same check. A school with the switch off sees nothing.

   NOTIFICATIONS. Going live (at once, or on approval) writes one bell entry
   per person in the audience -- in-app and push only, never SMS or WhatsApp.
   Several posts in a row by the same poster update the one unread entry
   rather than stacking new ones; once read, the next post brings it back. Inside the school's quiet hours the entry is
   written already marked pushed, so it waits in the bell and the phone stays
   quiet. Seeing every live post of a poster marks their entry read. */
import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { institutionId, js, marks, resolveScope } from '../teaching/common'
import { serveRange } from '../teaching/videos'
import { publish } from '../../services/live'
import { afterQuietHours, loadSettings } from '../../services/delivery'
import { LIFETIME_MS, MAX_BYTES, MODULE, cleanPolicy, statusPolicy, statusSummary, type StatusPolicy } from '../../services/class_status'
import { videoDurationSeconds } from '../../services/video_meta'
import type { StatusFeed } from '@shared/api/feature_class_status'

const POST = 'status.post'
const MANAGE = 'status.manage'
const SCHOOL = 'status.post_school'

const TYPES: Record<string, { kind: 'photo' | 'video'; ext: string }> = {
  'image/jpeg': { kind: 'photo', ext: '.jpg' }, 'image/png': { kind: 'photo', ext: '.png' }, 'image/webp': { kind: 'photo', ext: '.webp' },
  'video/mp4': { kind: 'video', ext: '.mp4' }, 'video/webm': { kind: 'video', ext: '.webm' }, 'video/quicktime': { kind: 'video', ext: '.mov' },
}
/* The small picture the bell and the strip show: drawn by the poster's
   browser (~320px), JPEG/WebP/PNG, never more than this. */
const THUMB_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/png': '.png' }
const THUMB_MAX = 256 << 10
const TEXT_MAX = 700
const KINDS = ['school', 'staff', 'class', 'section'] as const
type Target = { kind: (typeof KINDS)[number]; id: string }

interface PostRow {
  id: string; posted_by: string; as_school: number; media_kind: string; object_key: string; content_type: string
  size_bytes: number; duration_seconds: number | null; caption: string | null; status: string; pinned: number
  created_at: string; published_at: string | null; expires_at: string | null; thumb_key: string | null
}

/** Every R2 object a post owns (a text status has none). */
const objectsOf = (p: { object_key: string; thumb_key?: string | null }) => [p.object_key, p.thumb_key].filter((k): k is string => !!k)

// ---------------------------------------------------------------------------
// signed addresses

/* THE FEED VOUCHES FOR WHAT IT LISTS.

   Every thumbnail, every photo and every "seen" used to repeat the whole
   question of who is looking: the switch, the viewer's sections and children
   (six reads), the post, the audience test. Measured, 11 reads on the
   school's database for each one, on top of the sign-in's own; a strip of
   twenty statuses was two hundred reads to draw its pictures.

   The feed has already answered that question for everything it returns, so
   it signs each address for the person it was built for: an HMAC over the
   school, the post, the user and an expiry. The byte and "seen" routes check
   the signature and read ONE row (the post, with the switch in the same
   statement). A signature is for one person and one post, cannot be made
   without the server's key, and is honoured only for a signed-in session of
   that same person, so passing a link on gives nothing away. An address
   with no signature goes through the full check, as before.

   The expiry is rounded to a six-hour boundary so the address is the same
   on every feed refresh inside that window: the browser's cache keeps the
   picture instead of fetching it again each time the strip redraws. */
const SIG_WINDOW_MS = 6 * 3_600_000
const enc = new TextEncoder()
let hmacKey: { pepper: string; key: Promise<CryptoKey> } | null = null
function signingKey(c: Ctx): Promise<CryptoKey> {
  const pepper = c.env.PASSWORD_PEPPER
  if (hmacKey?.pepper !== pepper) {
    hmacKey = { pepper, key: crypto.subtle.importKey('raw', enc.encode('class-status-media:' + pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) }
  }
  return hmacKey.key
}
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/* `scope` is part of what is signed: 'l' (the feed) opens a post only while it
   is live and showing; 'a' (the poster's own list, the school's list) opens
   it in any state, because those lists show pending and expired posts to the
   people who may manage them. */
type SigScope = 'l' | 'a'
async function signature(c: Ctx, postId: string, exp: number, scope: SigScope = 'l'): Promise<string> {
  const msg = `${c.id.institution?.id ?? ''}.${postId}.${c.id.userId}.${exp}.${scope}`
  return b64url(await crypto.subtle.sign('HMAC', await signingKey(c), enc.encode(msg)))
}
/** `?exp=…&sig=…` for one post, for the person asking. */
async function signedQuery(c: Ctx, postId: string, exp: number, scope: SigScope = 'l'): Promise<string> {
  return `?exp=${exp}${scope === 'a' ? '&k=a' : ''}&sig=${await signature(c, postId, exp, scope)}`
}
const sigExpiry = () => (Math.floor(Date.now() / SIG_WINDOW_MS) + 2) * SIG_WINDOW_MS
/** True when the request carries a live signature for this post and this person. */
async function signed(c: Ctx, postId: string): Promise<SigScope | null> {
  const sig = c.url.searchParams.get('sig'), exp = Number(c.url.searchParams.get('exp'))
  if (!sig || !Number.isFinite(exp) || exp < Date.now() || !isUUID(postId)) return null
  const scope: SigScope = c.url.searchParams.get('k') === 'a' ? 'a' : 'l'
  const want = await signature(c, postId.toLowerCase(), exp, scope)
  if (want.length !== sig.length) return null
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0 ? scope : null
}
/** The post for a signed request: one read, the switch in the same statement. Live and still showing, or 404. */
async function signedPost(c: Ctx, id: string, scope: SigScope = 'l'): Promise<PostRow> {
  const p = await c.db.prepare(`SELECT p.*, COALESCE((SELECT m.enabled FROM module_settings m WHERE m.module = ?), 1) AS switched_on
      FROM status_posts p WHERE p.id = ?`).bind(MODULE, id.toLowerCase()).first<PostRow & { switched_on: number }>()
  if (!p || !p.switched_on) throw notFound()
  if (scope === 'l' && p.posted_by !== c.id.userId && (p.status !== 'live' || !(p.pinned || (p.expires_at ?? '') > now()))) throw notFound()
  return p
}

// ---------------------------------------------------------------------------
// who is looking

interface Viewer {
  userId: string
  admin: boolean
  staff: boolean
  /** Sections and classes the viewer is in the audience of (taught, or a child's). */
  sections: string[]
  classes: string[]
  /** Children reached (own record or as a guardian), with their section. */
  kids: { student_id: string; section_id: string; class_id: string }[]
  classTeacher: boolean
  teachSections: string[]
}

async function viewer(c: Ctx): Promise<Viewer> {
  const s = await resolveScope(c)
  const staff = c.id.roles.some((r) => r !== 'parent' && r !== 'student')
  const [secs, kids] = await c.db.batch([
    c.db.prepare(`SELECT id, class_id FROM sections WHERE id IN (${marks()})`).bind(js(s.sectionIds)),
    c.db.prepare(`SELECT e.student_id, e.section_id, e.class_id FROM enrollments e WHERE e.status = 'active' AND e.student_id IN (${marks()})`).bind(js(s.studentIds)),
  ])
  const kidRows = (kids.results as { student_id: string; section_id: string; class_id: string }[]).filter((k) => k.section_id)
  const sections = new Set<string>(), classes = new Set<string>()
  for (const r of secs.results as { id: string; class_id: string }[]) { sections.add(r.id); classes.add(r.class_id) }
  for (const k of kidRows) { sections.add(k.section_id); classes.add(k.class_id) }
  return {
    userId: c.id.userId, admin: can(c.id, MANAGE), staff, sections: [...sections], classes: [...classes], kids: kidRows,
    classTeacher: s.classTeacherOf.length > 0, teachSections: s.sectionIds,
  }
}

/** SQL predicate (alias p) and its binds: may this viewer see the post? */
function visible(v: Viewer): { sql: string; args: unknown[] } {
  if (v.admin) return { sql: '1', args: [] }
  return {
    sql: `(p.posted_by = ? OR EXISTS (SELECT 1 FROM status_post_targets t WHERE t.post_id = p.id AND (
        t.kind = 'school' OR (t.kind = 'staff' AND ? = 1)
        OR (t.kind = 'section' AND t.target_id IN (${marks()})) OR (t.kind = 'class' AND t.target_id IN (${marks()})))))`,
    args: [v.userId, v.staff ? 1 : 0, js(v.sections), js(v.classes)],
  }
}

async function policyOn(c: Ctx): Promise<StatusPolicy> {
  const p = await statusPolicy(c.db)
  if (!p.enabled) throw new HttpError(403, 'Class Status is switched off at this school', { code: 'status_off' })
  return p
}

async function load(c: Ctx, id: string): Promise<PostRow> {
  if (!isUUID(id)) throw notFound()
  const p = await c.db.prepare(`SELECT * FROM status_posts WHERE id = ?`).bind(id.toLowerCase()).first<PostRow>()
  if (!p) throw notFound()
  return p
}

/** The post, when this viewer may see it (live, or their own / an admin's); else 404. */
async function seeable(c: Ctx, v: Viewer, id: string): Promise<PostRow> {
  const p = await load(c, id)
  if (p.posted_by === v.userId || v.admin) return p
  if (p.status !== 'live') throw notFound()
  const vis = visible(v)
  const hit = await c.db.prepare(`SELECT 1 AS x FROM status_posts p WHERE p.id = ? AND ${vis.sql}`).bind(p.id, ...vis.args).first()
  if (!hit) throw notFound()
  return p
}

/** The poster's own post, or any post for whoever runs Class Status. */
async function ownOrAdmin(c: Ctx, id: string): Promise<PostRow> {
  const p = await load(c, id)
  if (p.posted_by !== c.id.userId && !can(c.id, MANAGE)) throw notFound()
  return p
}

// ---------------------------------------------------------------------------
// audiences

async function audienceLabels(c: Ctx, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const rows = (await c.db.prepare(`SELECT t.post_id, t.kind, cl.name AS class_name, scl.name AS sclass, sec.name AS section
      FROM status_post_targets t
      LEFT JOIN classes cl ON t.kind = 'class' AND cl.id = t.target_id
      LEFT JOIN sections sec ON t.kind = 'section' AND sec.id = t.target_id
      LEFT JOIN classes scl ON scl.id = sec.class_id
      WHERE t.post_id IN (${marks()}) ORDER BY t.kind, cl.name, scl.name, sec.name`).bind(js(ids))
    .all<{ post_id: string; kind: string; class_name: string | null; sclass: string | null; section: string | null }>()).results ?? []
  const parts = new Map<string, string[]>()
  for (const r of rows) {
    const l = r.kind === 'school' ? 'Whole school' : r.kind === 'staff' ? 'Staff' : r.kind === 'class' ? (r.class_name ?? 'A class')
      : `${r.sclass ?? ''} ${r.section ?? ''}`.trim() || 'A section'
    parts.set(r.post_id, [...(parts.get(r.post_id) ?? []), l])
  }
  for (const [k, v] of parts) out.set(k, v.join(', '))
  return out
}

/** One row per [post, user] in the audience of any of these posts (the poster included; callers drop them). */
const AUDIENCE_SQL = `
      WITH tg AS (SELECT t.post_id, t.kind, t.target_id FROM status_post_targets t WHERE t.post_id IN (SELECT value FROM json_each(?1))),
      /* The sections a target reaches: the section itself, or every section of the class. */
      ts AS (SELECT tg.post_id, sec.id AS section_id FROM tg JOIN sections sec ON (tg.kind = 'section' AND sec.id = tg.target_id) OR (tg.kind = 'class' AND sec.class_id = tg.target_id))
      SELECT tg.post_id, g.user_id AS user_id, MIN(e.student_id) AS student_id FROM tg
        JOIN enrollments e ON e.status = 'active' AND (tg.kind = 'school' OR (tg.kind = 'class' AND tg.target_id = e.class_id) OR (tg.kind = 'section' AND tg.target_id = e.section_id))
        JOIN student_guardians sg ON sg.student_id = e.student_id AND sg.portal_blocked = 0
        JOIN guardians g ON g.id = sg.guardian_id
       WHERE g.user_id IS NOT NULL GROUP BY tg.post_id, g.user_id
      UNION ALL
      SELECT DISTINCT tg.post_id, st.user_id, st.id FROM tg
        JOIN enrollments e ON e.status = 'active' AND (tg.kind = 'school' OR (tg.kind = 'class' AND tg.target_id = e.class_id) OR (tg.kind = 'section' AND tg.target_id = e.section_id))
        JOIN students st ON st.id = e.student_id
       WHERE st.user_id IS NOT NULL
      UNION ALL
      SELECT DISTINCT tg.post_id, u.id, NULL FROM tg JOIN users u ON u.status = 'active'
       WHERE tg.kind IN ('school', 'staff')
         AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key NOT IN ('parent', 'student'))
      UNION ALL
      /* A class or section post reaches its teachers too: the class teacher,
         whoever is assigned a subject in it, and whoever is on its timetable. */
      SELECT DISTINCT ts.post_id, u.id, NULL FROM ts JOIN users u ON u.status = 'active'
       WHERE EXISTS (SELECT 1 FROM sections s WHERE s.id = ts.section_id AND s.class_teacher_id = u.id)
          OR EXISTS (SELECT 1 FROM section_subject_teachers sst WHERE sst.section_id = ts.section_id AND sst.teacher_user_id = u.id)
          OR EXISTS (SELECT 1 FROM timetable_entries te WHERE te.section_id = ts.section_id AND te.teacher_user_id = u.id)`

/** Everyone the post is for (not the poster): [user, child through whom] pairs. */
async function audience(c: Ctx, postId: string, posterId: string): Promise<[string, string | null][]> {
  return (await audiences(c, [{ id: postId, posted_by: posterId }])).get(postId) ?? []
}

/** The same for many posts in one read: post id -> [user, child] pairs. */
async function audiences(c: Ctx, posts: { id: string; posted_by: string }[]): Promise<Map<string, [string, string | null][]>> {
  const out = new Map<string, [string, string | null][]>()
  if (!posts.length) return out
  const poster = new Map(posts.map((p) => [p.id, p.posted_by]))
  const seen = new Map<string, Set<string>>()
  for (let i = 0; i < posts.length; i += 200) {
    const rows = (await c.db.prepare(AUDIENCE_SQL).bind(js(posts.slice(i, i + 200).map((p) => p.id)))
      .all<{ post_id: string; user_id: string; student_id: string | null }>()).results ?? []
    for (const r of rows) {
      if (r.user_id === poster.get(r.post_id)) continue
      let s = seen.get(r.post_id)
      if (!s) { s = new Set(); seen.set(r.post_id, s); out.set(r.post_id, []) }
      if (s.has(r.user_id)) continue
      s.add(r.user_id)
      out.get(r.post_id)!.push([r.user_id, r.student_id])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// notifications

async function posterName(c: Ctx, p: PostRow): Promise<string> {
  if (p.as_school) {
    const b = await c.db.prepare(`SELECT display_name FROM branding_profiles WHERE campus_id IS NULL LIMIT 1`).first<{ display_name: string | null }>().catch(() => null)
    const inst = c.id.institution
    return b?.display_name || inst?.short_name || inst?.name || 'School'
  }
  const u = await c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(p.posted_by).first<{ full_name: string }>()
  return u?.full_name ?? 'A teacher'
}

const sourceOf = (p: Pick<PostRow, 'as_school' | 'posted_by'>) => (p.as_school ? 'school' : p.posted_by)

async function notifyAudience(c: Ctx, p: PostRow): Promise<number> {
  const people = await audience(c, p.id, p.posted_by)
  if (!people.length) return 0
  /* The notification is one row written for everybody at once, so anything
     in its title is read by families as well as staff. The audience label
     used to be in it -- "Priya Rao added a status · Whole school" -- which
     put the school's distribution list in front of parents and children. The
     label is carried by the feed instead, where only staff are given it. */
  const title = `${await posterName(c, p)} added a status`.slice(0, 200)
  const body = (p.caption ?? '').slice(0, 240) || (p.media_kind === 'video' ? 'Video' : p.media_kind === 'text' ? 'Text' : 'Photo')
  const link = `/?status=${p.id}`
  const at = now()
  const set = await loadSettings(c.db)
  const quiet = afterQuietHours(Date.now(), set.quiet_from, set.quiet_to) !== Date.now() ? at : null
  const inst = institutionId(c), src = sourceOf(p)
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < people.length; i += 400) {
    const part = people.slice(i, i + 400)
    const pairs = JSON.stringify(part.map(([u, s]) => [u, s, uuid()]))
    /* One entry per person per poster (notifications_one_per_source). An
       unread one is updated in place and not pushed again; a read or cleared
       one comes back unread, and is pushed as new. */
    stmts.push(c.db.prepare(`UPDATE notifications SET title = ?, body = ?, link = ?, created_at = ?,
          pushed_at = CASE WHEN read_at IS NULL AND dismissed_at IS NULL THEN pushed_at ELSE ? END, read_at = NULL, dismissed_at = NULL
        WHERE kind = 'status' AND source_kind = 'status' AND source_id = ?
          AND user_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`).bind(title, body, link, at, quiet, src, pairs))
    stmts.push(c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at, pushed_at)
        SELECT json_extract(j.value, '$[2]'), ?, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), 'status', ?, ?, ?, 'status', ?, ?, ?
          FROM json_each(?) j
         WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = json_extract(j.value, '$[0]') AND n.kind = 'status'
                             AND n.source_kind = 'status' AND n.source_id = ?)`)
      .bind(inst, title, body, link, src, at, quiet, pairs, src))
  }
  // Updates run before inserts per chunk, so a person never gets both.
  for (let i = 0; i < stmts.length; i += 40) await c.db.batch(stmts.slice(i, i + 40))
  await publish(c.env, inst, { users: people.map(([u]) => u), type: 'notification', scope: '', from: p.posted_by, keys: { kind: 'status', post: p.id } })
  return people.length
}

async function goLive(c: Ctx, p: PostRow): Promise<PostRow> {
  const at = new Date()
  const live = { ...p, status: 'live', published_at: at.toISOString(), expires_at: new Date(at.getTime() + LIFETIME_MS).toISOString() }
  await c.db.prepare(`UPDATE status_posts SET status = 'live', published_at = ?, expires_at = ?, decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, ?) WHERE id = ?`)
    .bind(live.published_at, live.expires_at, p.posted_by === c.id.userId ? null : c.id.userId, p.posted_by === c.id.userId ? null : live.published_at, p.id).run()
  await notifyAudience(c, live)
  return live
}

async function removePost(c: Ctx, p: PostRow) {
  const keys = objectsOf(p)
  if (keys.length) await c.env.FILES_WRITE.delete(keys)
  await c.db.batch([
    c.db.prepare(`DELETE FROM status_views WHERE post_id = ?`).bind(p.id),
    c.db.prepare(`DELETE FROM status_post_targets WHERE post_id = ?`).bind(p.id),
    c.db.prepare(`DELETE FROM status_posts WHERE id = ?`).bind(p.id),
  ])
}

// ---------------------------------------------------------------------------
// posting rules

function mayPost(c: Ctx, v: Viewer, pol: StatusPolicy, asSchool: boolean) {
  if (asSchool) { if (!can(c.id, SCHOOL)) throw forbidden('only the school office can post as the school'); return }
  if (!can(c.id, POST)) throw forbidden('you cannot post a class status')
  if (v.admin || can(c.id, SCHOOL)) return
  if (pol.who === 'admins') throw forbidden('at this school only the principal and the office post statuses')
  if (pol.who === 'class_teachers' && !v.classTeacher) throw forbidden('at this school only class teachers post statuses')
}

async function checkTargets(c: Ctx, v: Viewer, asSchool: boolean, raw: unknown): Promise<Target[]> {
  let list: unknown = raw
  if (typeof raw === 'string') { try { list = JSON.parse(raw) } catch { throw badRequest('targets must be a JSON list') } }
  if (!Array.isArray(list) || !list.length) throw badRequest('choose who the status is for')
  const out: Target[] = []
  const wide = asSchool || v.admin
  for (const t of list as { kind?: string; id?: string }[]) {
    const kind = String(t?.kind ?? '') as Target['kind']
    if (!KINDS.includes(kind)) throw badRequest('a target is school, staff, class or section')
    if (kind === 'school' || kind === 'staff') {
      if (kind === 'staff' && !wide) throw forbidden('only the school posts to the staff')
      out.push({ kind, id: '' }); continue
    }
    const id = String(t.id ?? '').toLowerCase()
    if (!isUUID(id)) throw badRequest(`${kind} needs an id`)
    if (kind === 'section') {
      const ok = await c.db.prepare(`SELECT 1 AS x FROM sections WHERE id = ?`).bind(id).first()
      if (!ok) throw badRequest('no such section')
      if (!wide && !v.teachSections.includes(id)) throw forbidden('you can post only to sections you teach')
    } else {
      const ok = await c.db.prepare(`SELECT 1 AS x FROM classes WHERE id = ?`).bind(id).first()
      if (!ok) throw badRequest('no such class')
      if (!wide) {
        const hit = await c.db.prepare(`SELECT 1 AS x FROM sections WHERE class_id = ? AND id IN (${marks()}) LIMIT 1`).bind(id, js(v.teachSections)).first()
        if (!hit) throw forbidden('you can post only to classes you teach')
      }
    }
    if (!out.some((o) => o.kind === kind && o.id === id)) out.push({ kind, id })
  }
  return out
}

// ---------------------------------------------------------------------------

/** Private to the signed-in browser, kept for twelve hours: the bytes behind a post id never change. */
const KEEP = 'private, max-age=43200, immutable'

/** The post behind a media or thumbnail request: one read on a signed address, the full check otherwise. */
async function mediaPost(c: Ctx): Promise<PostRow> {
  const scope = await signed(c, c.params.id)
  if (scope) return signedPost(c, c.params.id, scope)
  const pol = await statusPolicy(c.db)
  if (!pol.enabled) throw notFound()
  return seeable(c, await viewer(c), c.params.id)
}

export function registerClassStatus(r: Router): void {
  /* The rings: live posts this person may see, one ring per poster (the
     school's own first), unseen first, with the unseen count for the badge. */
  r.typed('GET /status/feed', 'auth', async (c) => {
    const pol = await statusPolicy(c.db)
    const canPost = can(c.id, POST) && pol.enabled
    const canSchool = can(c.id, SCHOOL) && pol.enabled
    const empty: StatusFeed = { enabled: pol.enabled, can_post: canPost, can_post_school: canSchool, unseen: 0, rings: [], gallery: [],
      allow_video: pol.allow_video, max_video_seconds: pol.max_video_seconds }
    if (!pol.enabled || !c.id.institution) return empty
    const v = await viewer(c)
    const vis = visible(v)
    const t = now()
    const rows = (await c.db.prepare(`SELECT p.id, p.posted_by, p.as_school, p.media_kind, p.content_type, p.caption, p.created_at, p.published_at,
          p.expires_at, p.pinned, p.duration_seconds, p.thumb_key, u.full_name AS poster_name, u.avatar_key,
          EXISTS (SELECT 1 FROM status_views sv WHERE sv.post_id = p.id AND sv.user_id = ?) AS seen
        FROM status_posts p JOIN users u ON u.id = p.posted_by
        WHERE p.status = 'live' AND (p.expires_at > ? OR p.pinned = 1) AND ${vis.sql}
        ORDER BY p.published_at LIMIT 400`).bind(v.userId, t, ...vis.args)
      .all<{ id: string; posted_by: string; as_school: number; media_kind: string; content_type: string; caption: string | null; created_at: string
        published_at: string; expires_at: string; pinned: number; duration_seconds: number | null; thumb_key: string | null; poster_name: string; avatar_key: string | null; seen: number }>()).results ?? []
    const labels = await audienceLabels(c, rows.map((x) => x.id))
    const exp = sigExpiry()
    const q = new Map(await Promise.all(rows.map(async (x) => [x.id, await signedQuery(c, x.id, exp)] as const)))
    const item = (x: (typeof rows)[number]) => ({
      id: x.id, media_kind: x.media_kind as 'photo' | 'video' | 'text', content_type: x.content_type, caption: x.caption ?? undefined,
      published_at: x.published_at, expires_at: x.expires_at, pinned: !!x.pinned, seen: !!x.seen, mine: x.posted_by === v.userId,
      /* WHO IT WENT TO IS THE SCHOOL'S BUSINESS.

         Every viewer was handed the audience label, so a parent opening the
         bell read "Whole school" under the post -- which tells a family how
         the school addresses them, and tells a child that the same picture
         went to everybody. Staff see it, because for them it is the point:
         it says which list they are reading. Families see the post. */
      audience: v.staff ? (labels.get(x.id) ?? '') : '', duration_seconds: x.duration_seconds ?? undefined,
      url: x.media_kind === 'text' ? '' : `/api/v1/status/posts/${x.id}/media${q.get(x.id)}`,
      thumb: x.thumb_key ? `/api/v1/status/posts/${x.id}/thumb${q.get(x.id)}` : undefined,
      seen_url: `/api/v1/status/posts/${x.id}/view${q.get(x.id)}`,
    })
    const rings = new Map<string, StatusFeed['rings'][number]>()
    const gallery: StatusFeed['gallery'] = []
    for (const x of rows) {
      if (x.expires_at <= t) { gallery.push(item(x)); continue }
      const key = x.as_school ? 'school' : x.posted_by
      let ring = rings.get(key)
      if (!ring) {
        ring = { key, as_school: !!x.as_school, poster_id: x.posted_by, name: x.as_school ? '' : x.poster_name, avatar_key: x.as_school ? undefined : x.avatar_key ?? undefined,
          mine: !x.as_school && x.posted_by === v.userId, unseen: 0, latest_at: x.published_at, posts: [] }
        rings.set(key, ring)
      }
      ring.posts.push(item(x))
      ring.latest_at = x.published_at
      if (!x.seen && x.posted_by !== v.userId) ring.unseen++
    }
    const list = [...rings.values()].sort((a, b) => (a.as_school !== b.as_school ? (a.as_school ? -1 : 1)
      : (a.unseen > 0) !== (b.unseen > 0) ? (a.unseen > 0 ? -1 : 1) : b.latest_at.localeCompare(a.latest_at)))
    return { ...empty, unseen: list.reduce((n, x) => n + x.unseen, 0), rings: list, gallery: gallery.reverse() }
  })

  /* Just the badge number, for a header that does not draw the rings. */
  r.get('/status/unseen', 'auth', async (c) => {
    const pol = await statusPolicy(c.db)
    if (!pol.enabled || !c.id.institution) return ok({ unseen: 0 })
    const v = await viewer(c)
    const vis = visible(v)
    const n = await c.db.prepare(`SELECT count(*) AS n FROM status_posts p WHERE p.status = 'live' AND p.expires_at > ? AND p.posted_by <> ?
        AND NOT EXISTS (SELECT 1 FROM status_views sv WHERE sv.post_id = p.id AND sv.user_id = ?) AND ${vis.sql}`)
      .bind(now(), v.userId, v.userId, ...vis.args).first<{ n: number }>()
    return ok({ unseen: n?.n ?? 0 })
  })

  /* What the composer may offer: the sections and classes this poster may reach. */
  r.get('/status/audiences', 'auth', async (c) => {
    /* Whoever runs Class Status needs this list to retarget somebody else's
       post, whether or not they post themselves. */
    if (!can(c.id, POST) && !can(c.id, SCHOOL) && !can(c.id, MANAGE)) throw forbidden()
    const pol = await policyOn(c)
    const v = await viewer(c)
    const wide = v.admin || can(c.id, SCHOOL) || can(c.id, MANAGE)
    const secs = (await c.db.prepare(`SELECT sec.id, sec.name, sec.class_id, cl.name AS class_name FROM sections sec JOIN classes cl ON cl.id = sec.class_id
        JOIN academic_years ay ON ay.id = sec.academic_year_id
        WHERE (ay.is_current = 1 OR ? = 0) ${wide ? '' : `AND sec.id IN (${marks()})`} ORDER BY cl.level, cl.name, sec.name`)
      .bind(...(wide ? [1] : [1, js(v.teachSections)])).all<{ id: string; name: string; class_id: string; class_name: string }>()).results ?? []
    const classes = new Map<string, string>()
    for (const s of secs) classes.set(s.class_id, s.class_name)
    return ok({
      sections: secs.map((s) => ({ id: s.id, name: `${s.class_name} ${s.name}`, class_id: s.class_id })),
      classes: [...classes].map(([id, name]) => ({ id, name })),
      can_post_school: can(c.id, SCHOOL), wide, allow_video: pol.allow_video, max_video_seconds: pol.max_video_seconds,
      needs_approval: pol.needs_approval && !v.admin, max_bytes: MAX_BYTES,
    })
  })

  /* Post: multipart form -- file, caption, targets (JSON [{kind, id}]), as_school, duration_seconds,
     and optionally thumb (a ~320px picture the browser drew). kind=text posts
     words alone (the caption, up to 700 characters) on the school's colour. */
  r.post('/status/posts', 'auth', async (c) => {
    const pol = await policyOn(c)
    let form: FormData
    try { form = await c.req.formData() } catch { throw badRequest('could not read the upload') }
    const asSchool = String(form.get('as_school') ?? '') === '1'
    const v = await viewer(c)
    mayPost(c, v, pol, asSchool)
    const targets = await checkTargets(c, v, asSchool, form.get('targets'))
    const isText = String(form.get('kind') ?? '') === 'text'
    const file = isText ? null : form.get('file') as unknown as File | string | null
    if (!isText && (!file || typeof file === 'string')) throw badRequest("attach the photo or video under 'file'")
    const ct = isText ? 'text/plain' : ((file as File).type || '').split(';')[0].trim().toLowerCase()
    const type = isText ? { kind: 'text' as const, ext: '' } : TYPES[ct]
    if (!type) throw badRequest('a status is a JPEG, PNG or WebP photo, or an MP4, WebM or MOV video')
    const size = file && typeof file !== 'string' ? file.size : 0
    if (!isText && (!size || size > MAX_BYTES)) throw badRequest('a status must be under 25 MB', { code: 'too_large' })
    let thumb: File | null = null
    const rawThumb = isText ? null : form.get('thumb') as unknown as File | string | null
    if (rawThumb && typeof rawThumb !== 'string' && rawThumb.size) {
      const tct = (rawThumb.type || '').split(';')[0].trim().toLowerCase()
      if (!THUMB_TYPES[tct]) throw badRequest('the thumbnail is a JPEG, PNG or WebP picture')
      if (rawThumb.size > THUMB_MAX) throw badRequest('the thumbnail must be under 256 KB')
      thumb = rawThumb
    }
    const bytes = file && typeof file !== 'string' ? await file.arrayBuffer() : null
    let duration: number | null = null
    if (type.kind === 'video') {
      if (!pol.allow_video) throw badRequest('this school takes photos only in Class Status', { code: 'no_video' })
      /* The length the file itself declares (MP4/MOV movie header) is what
         counts; the browser's figure is used only for a file that cannot be
         read that way (WebM, a damaged header). */
      const read = bytes ? videoDurationSeconds(ct, bytes) : null
      const claimed = Number(form.get('duration_seconds'))
      duration = read !== null && read > 0 ? read : claimed
      if (!(duration > 0)) throw badRequest('duration_seconds is required for a video')
      if (duration > pol.max_video_seconds + 0.5) {
        throw badRequest(`a video status can be at most ${pol.max_video_seconds} seconds; this one is ${Math.round(duration)}`, { code: 'too_long', duration_seconds: Math.round(duration * 10) / 10, max_video_seconds: pol.max_video_seconds })
      }
    }
    const caption = String(form.get('caption') ?? '').trim().slice(0, isText ? TEXT_MAX : 500) || null
    if (isText && !caption) throw badRequest('write something for a text status')
    const id = uuid(), inst = institutionId(c), t = now()
    const key = isText ? '' : `class-status/${inst}/${id}${type.ext}`
    const thumbKey = thumb ? `class-status/${inst}/${id}-thumb${THUMB_TYPES[thumb.type.split(';')[0].trim().toLowerCase()]}` : null
    if (bytes) await c.env.FILES_WRITE.put(key, bytes, { httpMetadata: { contentType: ct } })
    if (thumb && thumbKey) await c.env.FILES_WRITE.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: thumb.type.split(';')[0].trim().toLowerCase() } })
    const pending = pol.needs_approval && !v.admin
    try {
      await c.db.batch([
        c.db.prepare(`INSERT INTO status_posts (id, institution_id, posted_by, as_school, media_kind, object_key, content_type, size_bytes, duration_seconds, caption, status, created_at, thumb_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .bind(id, inst, c.id.userId, asSchool ? 1 : 0, type.kind, key, ct, size, duration, caption, t, thumbKey),
        ...targets.map((x) => c.db.prepare(`INSERT INTO status_post_targets (post_id, kind, target_id) VALUES (?, ?, ?)`).bind(id, x.kind, x.id)),
      ])
    } catch (e) {
      const keys = objectsOf({ object_key: key, thumb_key: thumbKey })
      if (keys.length) await c.env.FILES_WRITE.delete(keys).catch(() => {})
      throw e
    }
    let p = await load(c, id)
    if (!pending) p = await goLive(c, p)
    return ok({ id, status: p.status, expires_at: p.expires_at })
  })

  /* Before publishing: the children in this audience. Kept as a hook for
     photo consent; the school has no photo-consent records to check yet. */
  r.post('/status/consent-check', 'auth', async (c) => {
    if (!can(c.id, POST) && !can(c.id, SCHOOL)) throw forbidden()
    return ok({ refused: [] as { student_id: string; name: string }[], checked: false })
  })

  /* The poster's own posts, with views. */
  r.get('/status/mine', 'auth', async (c) => {
    if (!can(c.id, POST) && !can(c.id, SCHOOL)) throw forbidden()
    const rows = (await c.db.prepare(`SELECT p.id, p.as_school, p.media_kind, p.content_type, p.caption, p.status, p.pinned, p.created_at, p.published_at, p.expires_at, p.thumb_key,
          (SELECT count(*) FROM status_views sv WHERE sv.post_id = p.id) AS views
        FROM status_posts p WHERE p.posted_by = ? ORDER BY p.created_at DESC LIMIT 200`).bind(c.id.userId)
      .all<Record<string, unknown> & { id: string }>()).results ?? []
    const labels = await audienceLabels(c, rows.map((x) => x.id))
    const exp = sigExpiry()
    const q = new Map(await Promise.all(rows.map(async (x) => [x.id, await signedQuery(c, x.id, exp, 'a')] as const)))
    return ok({ items: rows.map(({ thumb_key, ...x }) => ({ ...x, pinned: !!x.pinned, as_school: !!x.as_school, audience: labels.get(x.id) ?? '',
      url: x.media_kind === 'text' ? '' : `/api/v1/status/posts/${x.id}/media${q.get(x.id)}`, thumb: thumb_key ? `/api/v1/status/posts/${x.id}/thumb${q.get(x.id)}` : undefined })) })
  })

  /* Who has seen it: names, and for a parent which child they came through. */
  r.get('/status/posts/{id}/views', 'auth', async (c) => {
    const p = await ownOrAdmin(c, c.params.id)
    const rows = (await c.db.prepare(`SELECT sv.user_id, u.full_name, sv.viewed_at, sv.student_id,
          trim(st.first_name || ' ' || COALESCE(st.last_name, '')) AS student_name,
          CASE WHEN st.user_id = sv.user_id THEN 'student' WHEN sv.student_id IS NOT NULL THEN 'parent' ELSE 'staff' END AS kind
        FROM status_views sv JOIN users u ON u.id = sv.user_id LEFT JOIN students st ON st.id = sv.student_id
        WHERE sv.post_id = ? ORDER BY sv.viewed_at DESC`).bind(p.id).all()).results ?? []
    const audienceSize = p.status === 'live' ? (await audience(c, p.id, p.posted_by)).length : 0
    return ok({ items: rows, views: rows.length, audience: audienceSize })
  })

  /* Seen. The first time only; a poster opening their own does not count. */
  r.post('/status/posts/{id}/view', 'auth', async (c) => {
    /* On a signed address (the feed's `seen_url`) this is the post, the
       child, the insert, and the bell when the viewer says this was the
       last unseen one of the ring: `last=1`. The viewer is trusted on that
       because all it can do is mark its OWN bell entry read. */
    if (await signed(c, c.params.id) === 'l') {
      const p = await signedPost(c, c.params.id)
      if (p.posted_by === c.id.userId || p.status !== 'live') return ok({ id: p.id, counted: false })
      const family = c.id.roles.some((r) => r === 'parent' || r === 'student')
      const stmts = [
        c.db.prepare(`INSERT OR IGNORE INTO status_views (post_id, user_id, student_id, viewed_at) VALUES (?1, ?2, ${family ? `(
            SELECT e.student_id FROM enrollments e WHERE e.status = 'active'
               AND e.student_id IN (SELECT id FROM students WHERE user_id = ?2 UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE g.user_id = ?2)
               AND EXISTS (SELECT 1 FROM status_post_targets t WHERE t.post_id = ?1 AND (t.kind = 'school' OR (t.kind = 'class' AND t.target_id = e.class_id) OR (t.kind = 'section' AND t.target_id = e.section_id)))
             LIMIT 1)` : 'NULL'}, ?3)`).bind(p.id, c.id.userId, now()),
      ]
      if (c.url.searchParams.get('last') === '1') {
        stmts.push(c.db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = 'status' AND source_kind = 'status' AND source_id = ? AND read_at IS NULL`)
          .bind(now(), c.id.userId, sourceOf(p)))
      }
      const res = await c.db.batch(stmts)
      return ok({ id: p.id, counted: (res[0].meta.changes ?? 0) > 0 })
    }
    await policyOn(c)
    const v = await viewer(c)
    const p = await seeable(c, v, c.params.id)
    if (p.posted_by === v.userId || p.status !== 'live') return ok({ id: p.id, counted: false })
    // The child through whom a parent is in this audience, for the poster's list.
    const kid = v.kids.length ? await c.db.prepare(`SELECT e.student_id FROM enrollments e WHERE e.status = 'active' AND e.student_id IN (${marks()})
        AND EXISTS (SELECT 1 FROM status_post_targets t WHERE t.post_id = ? AND (t.kind = 'school' OR (t.kind = 'class' AND t.target_id = e.class_id)
          OR (t.kind = 'section' AND t.target_id = e.section_id))) LIMIT 1`).bind(js(v.kids.map((k) => k.student_id)), p.id).first<{ student_id: string }>() : null
    const res = await c.db.prepare(`INSERT OR IGNORE INTO status_views (post_id, user_id, student_id, viewed_at) VALUES (?, ?, ?, ?)`)
      .bind(p.id, v.userId, kid?.student_id ?? null, now()).run()
    // Every live post of this poster seen: their bell entry is read.
    const vis = visible(v)
    const left = await c.db.prepare(`SELECT count(*) AS n FROM status_posts p WHERE p.status = 'live' AND p.expires_at > ?
        AND (CASE WHEN p.as_school = 1 THEN 'school' ELSE p.posted_by END) = ?
        AND NOT EXISTS (SELECT 1 FROM status_views sv WHERE sv.post_id = p.id AND sv.user_id = ?) AND ${vis.sql}`)
      .bind(now(), sourceOf(p), v.userId, ...vis.args).first<{ n: number }>()
    if (!left?.n) {
      await c.db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = 'status' AND source_kind = 'status' AND source_id = ? AND read_at IS NULL`)
        .bind(now(), v.userId, sourceOf(p)).run()
    }
    return ok({ id: p.id, counted: (res.meta.changes ?? 0) > 0 })
  })

  /* The bytes, after the audience check; Range for video. */
  r.get('/status/posts/{id}/media', 'auth', async (c) => {
    const p = await mediaPost(c)
    if (!p.object_key) throw notFound()
    // A post's bytes never change, so the browser may keep them for as long as the address lasts.
    return serveRange(c, p.object_key, p.content_type, KEEP)
  })

  /* The small picture for the bell and the strip: the same audience check. */
  r.get('/status/posts/{id}/thumb', 'auth', async (c) => {
    const p = await mediaPost(c)
    if (!p.thumb_key) throw notFound()
    const obj = await c.env.FILES_WRITE.get(p.thumb_key)
    if (!obj) throw notFound()
    return new Response(obj.body, { headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      'cache-control': KEEP,
      etag: obj.httpEtag,
      'x-content-type-options': 'nosniff',
    } })
  })

  r.post('/status/posts/{id}/pin', 'auth', async (c) => {
    const p = await ownOrAdmin(c, c.params.id)
    const b = await readJSON<{ pinned?: boolean }>(c.req).catch(() => ({} as { pinned?: boolean }))
    const pinned = b.pinned === undefined ? !p.pinned : !!b.pinned
    await c.db.prepare(`UPDATE status_posts SET pinned = ? WHERE id = ?`).bind(pinned ? 1 : 0, p.id).run()
    return ok({ id: p.id, pinned })
  })

  /* WHO CAN SEE IT, CHANGED AFTER THE FACT.

     A poster chooses the audience when they post, and gets it wrong: a class
     photo goes to the whole school, or a notice meant for everybody sits on
     one section. Until now the only remedy was to delete the post and ask
     them to put it up again, which loses the views and tells every parent who
     had seen it that it was taken down.

     Whoever runs Class Status can retarget a live post. Three things then
     have to agree: the targets, the notifications of the people who are no
     longer in the audience (dropped -- they were told about a post they can
     no longer open), and the notifications of the people newly in it
     (written, through the same path a new post uses, so one person still gets
     one row per poster). The post itself, its views and its clock are left
     exactly as they were. */
  r.post('/status/posts/{id}/audience', MANAGE, async (c) => {
    const p = await load(c, c.params.id)
    const v = await viewer(c)
    const body = await readJSON<{ targets?: unknown }>(c.req).catch(() => ({} as { targets?: unknown }))
    const targets = await checkTargets(c, v, true, body.targets)
    const before = new Set((await audience(c, p.id, p.posted_by)).map(([u]) => u))
    await c.db.batch([
      c.db.prepare(`DELETE FROM status_post_targets WHERE post_id = ?`).bind(p.id),
      ...targets.map((x) => c.db.prepare(`INSERT INTO status_post_targets (post_id, kind, target_id) VALUES (?, ?, ?)`).bind(p.id, x.kind, x.id)),
    ])
    const after = new Set((await audience(c, p.id, p.posted_by)).map(([u]) => u))
    const gone = [...before].filter((u) => !after.has(u))
    if (gone.length) {
      await c.db.prepare(`DELETE FROM notifications WHERE kind = 'status' AND source_kind = 'status' AND source_id = ?
                            AND user_id IN (SELECT value FROM json_each(?))`).bind(sourceOf(p), js(gone)).run()
    }
    if (p.status === 'live' && after.size) await notifyAudience(c, p)
    return ok({ id: p.id, audience: (await audienceLabels(c, [p.id])).get(p.id) ?? '', size: after.size })
  })

  r.del('/status/posts/{id}', 'auth', async (c) => {
    const p = await ownOrAdmin(c, c.params.id)
    await removePost(c, p)
    return ok({ id: p.id, deleted: true })
  })

  // --- the school's side -------------------------------------------------------

  /* Every post in the school: live, pinned and waiting, with views and seen %. */
  r.get('/status/admin/posts', MANAGE, async (c) => {
    const q = c.url.searchParams
    const where = [`(p.status = 'pending' OR (p.status = 'live' AND (p.expires_at > ? OR p.pinned = 1)))`]
    const args: unknown[] = [now()]
    const poster = q.get('poster_id')
    if (poster && isUUID(poster)) { where.push('p.posted_by = ?'); args.push(poster.toLowerCase()) }
    const cls = q.get('class_id')
    if (cls && isUUID(cls)) {
      where.push(`EXISTS (SELECT 1 FROM status_post_targets t LEFT JOIN sections sec ON t.kind = 'section' AND sec.id = t.target_id
          WHERE t.post_id = p.id AND ((t.kind = 'class' AND t.target_id = ?) OR sec.class_id = ?))`)
      args.push(cls.toLowerCase(), cls.toLowerCase())
    }
    const st = q.get('status')
    if (st === 'pending' || st === 'live') { where.push('p.status = ?'); args.push(st) }
    if (q.get('pinned') === '1') where.push('p.pinned = 1')
    const rows = (await c.db.prepare(`SELECT p.id, p.posted_by, u.full_name AS poster_name, p.as_school, p.media_kind, p.content_type, p.caption, p.status,
          p.pinned, p.created_at, p.published_at, p.expires_at, p.thumb_key, (SELECT count(*) FROM status_views sv WHERE sv.post_id = p.id) AS views
        FROM status_posts p JOIN users u ON u.id = p.posted_by WHERE ${where.join(' AND ')}
        ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 200`).bind(...args)
      .all<Record<string, unknown> & { id: string; posted_by: string; status: string; views: number }>()).results ?? []
    // One read for the labels and one for every live post's audience, not one per row.
    const [labels, sizes] = await Promise.all([audienceLabels(c, rows.map((x) => x.id)), audiences(c, rows.filter((x) => x.status === 'live'))])
    const exp = sigExpiry()
    const sig = new Map(await Promise.all(rows.map(async (x) => [x.id, await signedQuery(c, x.id, exp, 'a')] as const)))
    const items = rows.map((x) => {
      const size = sizes.get(x.id)?.length ?? 0
      return { ...x, pinned: !!x.pinned, as_school: !!x.as_school, audience: labels.get(x.id) ?? '', audience_size: size,
        seen_pct: size ? Math.round((100 * x.views) / size) : 0, thumb_key: undefined,
        url: x.media_kind === 'text' ? '' : `/api/v1/status/posts/${x.id}/media${sig.get(x.id)}`, thumb: x.thumb_key ? `/api/v1/status/posts/${x.id}/thumb${sig.get(x.id)}` : undefined }
    })
    const [posters, classes] = await c.db.batch([
      c.db.prepare(`SELECT DISTINCT u.id, u.full_name AS name FROM status_posts p JOIN users u ON u.id = p.posted_by ORDER BY u.full_name`),
      c.db.prepare(`SELECT id, name FROM classes ORDER BY level, name`),
    ])
    return ok({ items, posters: posters.results, classes: classes.results, settings: await statusPolicy(c.db) })
  })

  r.post('/status/posts/{id}/approve', MANAGE, async (c) => {
    await policyOn(c)
    const p = await load(c, c.params.id)
    if (p.status !== 'pending') throw new HttpError(409, 'this status is not waiting for approval', { code: 'not_pending' })
    await c.db.prepare(`UPDATE status_posts SET decided_by = ?, decided_at = ? WHERE id = ?`).bind(c.id.userId, now(), p.id).run()
    const live = await goLive(c, p)
    return ok({ id: p.id, status: live.status, expires_at: live.expires_at })
  })

  r.post('/status/posts/{id}/reject', MANAGE, async (c) => {
    const p = await load(c, c.params.id)
    if (p.status !== 'pending') throw new HttpError(409, 'this status is not waiting for approval', { code: 'not_pending' })
    // Nobody will ever see it: the bytes go now, the row stays a day for the poster's "My posts".
    const keys = objectsOf(p)
    if (keys.length) await c.env.FILES_WRITE.delete(keys)
    await c.db.prepare(`UPDATE status_posts SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`).bind(c.id.userId, now(), p.id).run()
    return ok({ id: p.id, status: 'rejected' })
  })

  /* A small figure for the principal's board: live today, waiting. */
  r.get('/status/summary', MANAGE, async (c) => ok(await statusSummary(c.db)))

  r.get('/status/settings', MANAGE, async (c) => ok(await statusPolicy(c.db)))

  r.put('/status/settings', MANAGE, async (c) => {
    const b = await readJSON<Record<string, unknown>>(c.req)
    const next = cleanPolicy(b, await statusPolicy(c.db))
    const { enabled, ...config } = next
    await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, ?, ?)
        ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`)
      .bind(institutionId(c), MODULE, enabled ? 1 : 0, JSON.stringify(config)).run()
    return ok({ ...next, chosen: true })
  })
}
