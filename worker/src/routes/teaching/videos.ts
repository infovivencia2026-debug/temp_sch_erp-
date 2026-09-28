import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, like, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { institutionId, js, marks, requirePerm, resolveScope } from './common'

/* The LMS video library: videos a teacher uploads for lessons.

   Bytes go to R2 through the Worker as a multipart upload, because a Worker
   request body is capped near 100 MB: the browser asks to start (the row is
   'uploading' and R2 hands back an upload id), sends fixed-size parts one
   request each (a part that failed is simply sent again; the parts already
   received are listed so a reload resumes), then completes. Objects live in
   FILES_WRITE only, under lms-videos/<institution>/, and are never public:
   playback is GET /lms/videos/{id}/stream, which answers HTTP Range requests
   (206) after checking the caller may play it:
     - its uploader, and the library's administrator (anyone who sees every
       student, or holds lms_admin.lms.courses);
     - a teacher whose course has a lesson that uses it;
     - a child (or their parent) when a lesson they can see uses it.
   There is no transcoding: what is uploaded is what is played. */

const P = 'academics.timetable.read'
const HW = 'academics.homework.write'
export const PART_SIZE = 20 << 20
export const DEFAULT_MAX_FILE = 2 * 1024 ** 3
export const DEFAULT_MAX_TOTAL = 50 * 1024 ** 3
const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const THUMB_MAX = 1 << 20

type Body = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const optUUID = (v: unknown, what: string) => {
  const s = str(v)
  if (!s) return null
  if (!isUUID(s)) throw badRequest(`${what} must be a uuid`)
  return s.toLowerCase()
}

interface VideoRow {
  id: string; title: string; object_key: string; upload_id: string | null; part_size: number | null; size_bytes: number
  content_type: string; thumb_key: string | null; status: string; uploaded_by: string | null; duration_seconds: number | null
}

export async function isLibraryAdmin(c: Ctx): Promise<boolean> {
  if (can(c.id, 'lms_admin.lms.courses')) return true
  return (await resolveScope(c)).allStudents
}

export async function limits(c: Ctx) {
  const r = await c.db.prepare(`SELECT max_file_bytes, max_total_bytes FROM lms_video_limits WHERE institution_id = ?`).bind(institutionId(c))
    .first<{ max_file_bytes: number; max_total_bytes: number }>()
  const used = await c.db.prepare(`SELECT COALESCE(sum(size_bytes), 0) AS n, count(*) AS c FROM lms_videos WHERE status IN ('ready','uploading')`).first<{ n: number; c: number }>()
  return { max_file_bytes: r?.max_file_bytes ?? DEFAULT_MAX_FILE, max_total_bytes: r?.max_total_bytes ?? DEFAULT_MAX_TOTAL, used_bytes: used?.n ?? 0, videos: used?.c ?? 0, part_size: PART_SIZE }
}

async function load(c: Ctx, id: string): Promise<VideoRow> {
  if (!isUUID(id)) throw notFound()
  const v = await c.db.prepare(`SELECT id, title, object_key, upload_id, part_size, size_bytes, content_type, thumb_key, status, uploaded_by, duration_seconds FROM lms_videos WHERE id = ?`)
    .bind(id.toLowerCase()).first<VideoRow>()
  if (!v) throw notFound()
  return v
}

/** The caller's own video, or any when they run the library; otherwise 404. */
async function mine(c: Ctx, id: string): Promise<VideoRow> {
  const v = await load(c, id)
  if (v.uploaded_by !== c.id.userId && !(await isLibraryAdmin(c))) throw notFound()
  return v
}

/** A ready library video this caller may put in a lesson; for lessons.ts. */
export async function checkLessonVideo(c: Ctx, id: string): Promise<string> {
  const v = await mine(c, id).catch(() => { throw badRequest('that video is not in your library') })
  if (v.status !== 'ready') throw badRequest('that video has not finished uploading')
  return v.id
}

/** May this caller play this video? See the header comment. */
export async function canPlay(c: Ctx, v: VideoRow): Promise<boolean> {
  if (v.uploaded_by === c.id.userId) return true
  if (can(c.id, P)) {
    if (await isLibraryAdmin(c)) return true
    const s = await resolveScope(c)
    if (s.sectionIds.length) {
      const hit = await c.db.prepare(`SELECT 1 AS x FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
          JOIN sections sec ON sec.class_id = cs.class_id AND (l.section_id IS NULL OR l.section_id = sec.id)
          WHERE l.video_id = ? AND sec.id IN (${marks()}) LIMIT 1`).bind(v.id, js(s.sectionIds)).first()
      if (hit) return true
    }
  }
  const s = await resolveScope(c)
  if (!s.studentIds.length) return false
  const hit = await c.db.prepare(`SELECT 1 AS x FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
      JOIN enrollments e ON e.class_id = cs.class_id AND e.status = 'active' AND (l.section_id IS NULL OR l.section_id = e.section_id)
      WHERE l.video_id = ? AND e.student_id IN (${marks()}) AND l.is_published = 1 AND su.is_active = 1
        AND (l.publish_at IS NULL OR l.publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 1`).bind(v.id, js(s.studentIds)).first()
  return !!hit
}

/** Parse one "bytes=" range against a size. null: no (usable) range; 'bad': unsatisfiable. */
export function parseRange(h: string | null, size: number): { offset: number; length: number } | null | 'bad' {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    if (n <= 0 || size === 0) return 'bad'
    const len = Math.min(n, size)
    return { offset: size - len, length: len }
  }
  const start = Number(m[1])
  if (start >= size) return 'bad'
  let end = m[2] === '' ? size - 1 : Number(m[2])
  if (end < start) return 'bad'
  end = Math.min(end, size - 1)
  return { offset: start, length: end - start + 1 }
}

/** An R2 object from FILES_WRITE as 200 or 206, with Accept-Ranges and Content-Range. */
export async function serveRange(c: Ctx, key: string, contentType: string): Promise<Response> {
  const head = await c.env.FILES_WRITE.head(key)
  if (!head) throw notFound()
  const size = head.size
  const base: Record<string, string> = {
    'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff', 'content-disposition': 'inline', etag: head.httpEtag, 'last-modified': head.uploaded.toUTCString(),
  }
  const r = parseRange(c.req.headers.get('range'), size)
  if (r === 'bad') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } })
  if (!r) {
    if (c.req.method === 'HEAD') return new Response(null, { headers: { ...base, 'content-length': String(size) } })
    const obj = await c.env.FILES_WRITE.get(key)
    if (!obj) throw notFound()
    return new Response(obj.body, { headers: { ...base, 'content-length': String(size) } })
  }
  const obj = await c.env.FILES_WRITE.get(key, { range: r })
  if (!obj) throw notFound()
  return new Response(obj.body, { status: 206, headers: { ...base, 'content-length': String(r.length), 'content-range': `bytes ${r.offset}-${r.offset + r.length - 1}/${size}` } })
}

async function removeObjects(c: Ctx, v: VideoRow) {
  if (v.upload_id) await c.env.FILES_WRITE.resumeMultipartUpload(v.object_key, v.upload_id).abort().catch(() => {})
  await c.env.FILES_WRITE.delete([v.object_key, ...(v.thumb_key ? [v.thumb_key] : [])])
}

export function registerVideos(r: Router) {
  /* The library: own videos, or every one for its administrator. Search, filter, and the school's usage. */
  r.get('/lms/videos', P, async (c) => {
    const admin = await isLibraryAdmin(c)
    const q = c.url.searchParams
    const where: string[] = []
    const args: unknown[] = []
    if (!admin || q.get('mine') === '1') { where.push('v.uploaded_by = ?'); args.push(c.id.userId) }
    const text = str(q.get('q'))
    if (text) { where.push(`(v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')`); args.push(like(text), like(text)) }
    for (const [k, col] of [['subject_id', 'v.subject_id'], ['class_id', 'v.class_id']] as const) {
      const val = optUUID(q.get(k), k)
      if (val) { where.push(`${col} = ?`); args.push(val) }
    }
    const st = str(q.get('status'))
    if (st) { if (!['uploading', 'ready', 'failed'].includes(st)) throw badRequest('status must be uploading, ready or failed'); where.push('v.status = ?'); args.push(st) }
    const rows = await c.db.prepare(`SELECT v.id, v.title, v.description, v.duration_seconds, v.size_bytes, v.content_type, v.original_name, v.status,
        v.subject_id, sub.name AS subject, v.class_id, cl.name AS class_name, v.uploaded_by, u.full_name AS uploader, v.created_at,
        (v.thumb_key IS NOT NULL) AS has_thumb, (SELECT count(*) FROM lms_lessons l WHERE l.video_id = v.id) AS lessons,
        (SELECT count(*) FROM lms_video_parts p WHERE p.video_id = v.id) AS parts_received, v.part_size
        FROM lms_videos v LEFT JOIN subjects sub ON sub.id = v.subject_id LEFT JOIN classes cl ON cl.id = v.class_id LEFT JOIN users u ON u.id = v.uploaded_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.created_at DESC LIMIT 500`).bind(...args).all<Record<string, unknown>>()
    const [subjects, classes] = await c.db.batch([
      c.db.prepare(`SELECT id, name FROM subjects ORDER BY name`),
      c.db.prepare(`SELECT id, name FROM classes ORDER BY level, name`),
    ])
    return ok({ admin, usage: await limits(c), items: rows.results.map((x) => ({ ...x, has_thumb: !!x.has_thumb })), subjects: subjects.results, classes: classes.results })
  })

  /* The school's caps; the library administrator may change them. */
  r.put('/lms/videos/limits', P, async (c) => {
    if (!(await isLibraryAdmin(c))) throw forbidden('only the LMS administrator can change the video limits')
    const b = await readJSON<Body>(c.req)
    const f = Number(b.max_file_bytes), t = Number(b.max_total_bytes)
    if (!(f >= 10 << 20 && f <= 5 * 1024 ** 3)) throw badRequest('the per-file limit must be between 10 MB and 5 GB')
    if (!(t >= f && t <= 2 * 1024 ** 4)) throw badRequest('the school total must be at least the per-file limit and at most 2 TB')
    await c.db.prepare(`INSERT INTO lms_video_limits (institution_id, max_file_bytes, max_total_bytes, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET max_file_bytes = excluded.max_file_bytes, max_total_bytes = excluded.max_total_bytes, updated_at = excluded.updated_at`)
      .bind(institutionId(c), Math.trunc(f), Math.trunc(t), now()).run()
    return ok(await limits(c))
  })

  /* Start an upload. */
  r.post('/lms/videos/uploads', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const name = str(b.filename).replace(/.*[\\/]/, '')
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
    const ct = TYPES[ext]
    if (!ct) throw badRequest('upload an mp4, webm or mov video')
    const size = Math.trunc(Number(b.size_bytes))
    if (!(size > 0)) throw badRequest('size_bytes is required')
    const lim = await limits(c)
    if (size > lim.max_file_bytes) throw badRequest(`this video is larger than the school's limit of ${Math.round(lim.max_file_bytes / 1024 ** 2)} MB per file`, { code: 'too_large' })
    if (lim.used_bytes + size > lim.max_total_bytes) throw new HttpError(409, "the school's video storage is full; delete old videos or ask the LMS administrator to raise the limit", { code: 'quota_full' })
    const title = (str(b.title) || name.slice(0, dot >= 0 ? dot : undefined) || 'Video').slice(0, 200)
    const id = uuid(), inst = institutionId(c), t = now()
    const key = `lms-videos/${inst}/${id}${ext === '.m4v' ? '.mp4' : ext}`
    const mp = await c.env.FILES_WRITE.createMultipartUpload(key, { httpMetadata: { contentType: ct } })
    await c.db.prepare(`INSERT INTO lms_videos (id, institution_id, title, description, duration_seconds, size_bytes, content_type, original_name, object_key, upload_id, part_size,
        subject_id, class_id, status, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`)
      .bind(id, inst, title, str(b.description).slice(0, 2000) || null, Number(b.duration_seconds) > 0 ? Number(b.duration_seconds) : null, size, ct, name.slice(0, 200),
        key, mp.uploadId, PART_SIZE, optUUID(b.subject_id, 'subject_id'), optUUID(b.class_id, 'class_id'), c.id.userId, t, t).run()
    return ok({ id, part_size: PART_SIZE, parts: Math.ceil(size / PART_SIZE), content_type: ct })
  })

  /* One part, as the raw request body. Sending a part again replaces it. */
  r.put('/lms/videos/{id}/parts/{n}', P, async (c) => {
    requirePerm(c, HW)
    const v = await mine(c, c.params.id)
    if (v.status !== 'uploading' || !v.upload_id || !v.part_size) throw new HttpError(409, 'this upload is not open', { code: 'not_uploading' })
    const n = Number(c.params.n)
    const total = Math.ceil(v.size_bytes / v.part_size)
    if (!Number.isInteger(n) || n < 1 || n > total) throw badRequest(`part must be from 1 to ${total}`)
    const want = n < total ? v.part_size : v.size_bytes - (total - 1) * v.part_size
    const bytes = await c.req.arrayBuffer()
    if (bytes.byteLength !== want) throw badRequest(`part ${n} must be ${want} bytes, got ${bytes.byteLength}`)
    const part = await c.env.FILES_WRITE.resumeMultipartUpload(v.object_key, v.upload_id).uploadPart(n, bytes)
    await c.db.prepare(`INSERT INTO lms_video_parts (video_id, part_number, etag, size_bytes) VALUES (?, ?, ?, ?)
        ON CONFLICT (video_id, part_number) DO UPDATE SET etag = excluded.etag, size_bytes = excluded.size_bytes`).bind(v.id, n, part.etag, want).run()
    return ok({ part: n, size: want })
  })

  /* One video, with the parts received so far (to resume). */
  r.get('/lms/videos/{id}', P, async (c) => {
    const v = await mine(c, c.params.id)
    const parts = await c.db.prepare(`SELECT part_number FROM lms_video_parts WHERE video_id = ? ORDER BY part_number`).bind(v.id).all<{ part_number: number }>()
    return ok({ id: v.id, title: v.title, status: v.status, size_bytes: v.size_bytes, part_size: v.part_size, content_type: v.content_type,
      duration_seconds: v.duration_seconds, has_thumb: !!v.thumb_key, parts_received: parts.results.map((p) => p.part_number) })
  })

  r.post('/lms/videos/{id}/complete', P, async (c) => {
    requirePerm(c, HW)
    const v = await mine(c, c.params.id)
    if (v.status === 'ready') return ok({ id: v.id, status: 'ready' })
    if (v.status !== 'uploading' || !v.upload_id || !v.part_size) throw new HttpError(409, 'this upload is not open', { code: 'not_uploading' })
    const b = await readJSON<Body>(c.req).catch(() => ({} as Body))
    const total = Math.ceil(v.size_bytes / v.part_size)
    const parts = await c.db.prepare(`SELECT part_number, etag, size_bytes FROM lms_video_parts WHERE video_id = ? ORDER BY part_number`).bind(v.id)
      .all<{ part_number: number; etag: string; size_bytes: number }>()
    const missing: number[] = []
    for (let i = 1; i <= total; i++) if (!parts.results.some((p) => p.part_number === i)) missing.push(i)
    if (missing.length) throw new HttpError(409, `parts still to send: ${missing.slice(0, 20).join(', ')}`, { code: 'parts_missing', missing })
    await c.env.FILES_WRITE.resumeMultipartUpload(v.object_key, v.upload_id).complete(parts.results.map((p) => ({ partNumber: p.part_number, etag: p.etag })))
    const head = await c.env.FILES_WRITE.head(v.object_key)
    if (!head || head.size !== v.size_bytes) {
      await c.db.prepare(`UPDATE lms_videos SET status = 'failed', upload_id = NULL, updated_at = ? WHERE id = ?`).bind(now(), v.id).run()
      throw new HttpError(500, 'the stored video is not the size that was sent; upload it again')
    }
    const dur = Number(b.duration_seconds)
    await c.db.batch([
      c.db.prepare(`UPDATE lms_videos SET status = 'ready', upload_id = NULL, duration_seconds = COALESCE(?, duration_seconds), updated_at = ? WHERE id = ?`)
        .bind(dur > 0 ? dur : null, now(), v.id),
      c.db.prepare(`DELETE FROM lms_video_parts WHERE video_id = ?`).bind(v.id),
    ])
    return ok({ id: v.id, status: 'ready' })
  })

  /* Give up on an upload: the parts are thrown away and the row is marked failed. */
  r.post('/lms/videos/{id}/abort', P, async (c) => {
    requirePerm(c, HW)
    const v = await mine(c, c.params.id)
    if (v.status !== 'uploading') return ok({ id: v.id, status: v.status })
    if (v.upload_id) await c.env.FILES_WRITE.resumeMultipartUpload(v.object_key, v.upload_id).abort().catch(() => {})
    await c.db.batch([
      c.db.prepare(`UPDATE lms_videos SET status = 'failed', upload_id = NULL, updated_at = ? WHERE id = ?`).bind(now(), v.id),
      c.db.prepare(`DELETE FROM lms_video_parts WHERE video_id = ?`).bind(v.id),
    ])
    return ok({ id: v.id, status: 'failed' })
  })

  /* The poster frame the browser captured: a small JPEG or PNG as the raw body. */
  r.put('/lms/videos/{id}/thumbnail', P, async (c) => {
    requirePerm(c, HW)
    const v = await mine(c, c.params.id)
    const ct = (c.req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(ct)) throw badRequest('the thumbnail must be a JPEG, PNG or WebP image')
    const bytes = await c.req.arrayBuffer()
    if (!bytes.byteLength || bytes.byteLength > THUMB_MAX) throw badRequest('the thumbnail must be under 1 MB')
    const key = `lms-videos/${institutionId(c)}/${v.id}.thumb`
    await c.env.FILES_WRITE.put(key, bytes, { httpMetadata: { contentType: ct } })
    await c.db.prepare(`UPDATE lms_videos SET thumb_key = ?, updated_at = ? WHERE id = ?`).bind(key, now(), v.id).run()
    return ok({ id: v.id, has_thumb: true })
  })

  /* Rename, describe, file under a subject or class. */
  r.patch('/lms/videos/{id}', P, async (c) => {
    requirePerm(c, HW)
    const v = await mine(c, c.params.id)
    const b = await readJSON<Body>(c.req)
    const sets: string[] = [], args: unknown[] = []
    if (b.title !== undefined) { const t = str(b.title); if (!t) throw badRequest('a video needs a title'); sets.push('title = ?'); args.push(t.slice(0, 200)) }
    if (b.description !== undefined) { sets.push('description = ?'); args.push(str(b.description).slice(0, 2000) || null) }
    if (b.subject_id !== undefined) { sets.push('subject_id = ?'); args.push(optUUID(b.subject_id, 'subject_id')) }
    if (b.class_id !== undefined) { sets.push('class_id = ?'); args.push(optUUID(b.class_id, 'class_id')) }
    if (b.duration_seconds !== undefined && Number(b.duration_seconds) > 0) { sets.push('duration_seconds = ?'); args.push(Number(b.duration_seconds)) }
    if (!sets.length) return ok({ id: v.id })
    await c.db.prepare(`UPDATE lms_videos SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, now(), v.id).run()
    return ok({ id: v.id })
  })

  /* Delete: the R2 object and thumbnail go, lessons that used it lose it. */
  r.del('/lms/videos/{id}', P, async (c) => {
    requirePerm(c, HW)
    const v = await mine(c, c.params.id)
    await removeObjects(c, v)
    const used = await c.db.prepare(`SELECT count(*) AS n FROM lms_lessons WHERE video_id = ?`).bind(v.id).first<{ n: number }>()
    await c.db.batch([
      c.db.prepare(`DELETE FROM lms_video_progress WHERE video_id = ?`).bind(v.id),
      c.db.prepare(`UPDATE lms_lessons SET video_id = NULL, updated_at = ? WHERE video_id = ?`).bind(now(), v.id),
      c.db.prepare(`DELETE FROM lms_video_parts WHERE video_id = ?`).bind(v.id),
      c.db.prepare(`DELETE FROM lms_videos WHERE id = ?`).bind(v.id),
    ])
    return ok({ id: v.id, deleted: true, lessons_cleared: used?.n ?? 0 })
  })

  /* Playback, with Range. 'auth': children and parents reach it too; canPlay decides. */
  r.get('/lms/videos/{id}/stream', 'auth', async (c) => {
    const v = await load(c, c.params.id)
    if (v.status !== 'ready' || !(await canPlay(c, v))) throw notFound()
    return serveRange(c, v.object_key, v.content_type)
  })

  r.get('/lms/videos/{id}/thumbnail', 'auth', async (c) => {
    const v = await load(c, c.params.id)
    if (!v.thumb_key || !(await canPlay(c, v))) throw notFound()
    const obj = await c.env.FILES_WRITE.get(v.thumb_key)
    if (!obj) throw notFound()
    return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } })
  })
}

/** Seconds per bucket of the `watched` map for a video this long (at most 2000 buckets). */
export const bucketFor = (duration: number) => Math.max(5, Math.ceil(duration / 2000))

/** OR two watched maps of n buckets. */
export function mergeWatched(a: string, b: string, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += a[i] === '1' || b[i] === '1' ? '1' : '0'
  return out
}
