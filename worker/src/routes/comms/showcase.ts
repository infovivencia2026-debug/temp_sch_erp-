import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionId, requirePerm } from '../teaching/common'
import { classDash, firstLast, isDate, isoZ, omitNull, optInt, trim, ymdOf } from './common'

/* Port of the achievements showcase in comms.go: the school's register of
   student_achievements, the pictures on each (achievement_media), the
   per-achievement consent record, and publishing to the parent portal.

   student_achievements_touch (BEFORE UPDATE -> updated_at) is re-implemented
   by setting updated_at on every UPDATE below. */

const READ = 'students.read'
const WRITE = 'students.write'
const PUBLISH = 'comms.announcements.write'

const KINDS = new Set(['award', 'sport', 'club', 'activity', 'competition', 'position'])
const LEVELS = new Set(['class', 'school', 'district', 'state', 'national', 'international'])
const BASES = new Set(['admission_form', 'signed_consent_form', 'portal_confirmation', 'recorded_verbal', 'staff_child'])
const KIND_MSG = 'kind must be award, sport, club, activity, competition or position'
const LEVEL_MSG = 'level must be class, school, district, state, national or international'

const showcaseSelect = `
  SELECT a.id, a.student_id, ${firstLast('st')} AS student, ${classDash('c', 'sec')} AS class,
         a.kind, a.title, a.description, a.showcase_note, a.level, a."position" AS position,
         ${ymdOf('a.awarded_on')} AS awarded_on, a.is_published, ${isoZ('a.published_at')} AS published_at,
         pu.full_name AS published_by, a.consent_basis, cu.full_name AS consent_confirmed_by,
         ${isoZ('a.consent_confirmed_at')} AS consent_confirmed_at,
         (SELECT count(*) FROM achievement_media m WHERE m.achievement_id = a.id) AS media_count
    FROM student_achievements a
    JOIN students st ON st.id = a.student_id
    LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
    LEFT JOIN sections sec ON sec.id = en.section_id
    LEFT JOIN classes c ON c.id = sec.class_id
    LEFT JOIN users pu ON pu.id = a.published_by
    LEFT JOIN users cu ON cu.id = a.consent_confirmed_by`

function showcaseRow(v: Record<string, unknown>): Record<string, unknown> {
  return omitNull({
    id: v.id, student_id: v.student_id, student: v.student, class: v.class, kind: v.kind, title: v.title,
    description: v.description, showcase_note: v.showcase_note, level: v.level, position: v.position,
    awarded_on: v.awarded_on, is_published: bool(v.is_published), published_at: v.published_at,
    published_by: v.published_by, consent_basis: v.consent_basis, consent_confirmed_by: v.consent_confirmed_by,
    consent_confirmed_at: v.consent_confirmed_at, media_count: Number(v.media_count ?? 0),
  })
}

export function mediaRow(v: Record<string, unknown>): Record<string, unknown> {
  return omitNull({ id: v.id, file_id: v.file_id, file_name: v.file_name, external_url: v.external_url,
    caption: v.caption, sort_order: Number(v.sort_order ?? 0) })
}

function entryParam(c: Ctx): string {
  if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
  return c.params.id
}

/** Go answers a failed write with 400 and the error text. */
async function asBadRequest<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    if (e instanceof HttpError) throw e
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
}

async function listShowcase(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const kind = (q.get('kind') ?? '').trim(), level = (q.get('level') ?? '').trim(), text = (q.get('q') ?? '').trim()
  const sid = (q.get('student_id') ?? '').trim()
  const student = isUUID(sid) ? sid : null
  const rows = await c.db.prepare(`${showcaseSelect}
      WHERE (? = '' OR a.kind = ?) AND (? = '' OR a.level = ?) AND (? IS NULL OR a.student_id = ?)
        AND (? = '' OR a.title LIKE '%' || ? || '%')
      ORDER BY a.awarded_on DESC NULLS LAST, a.created_at DESC
      LIMIT 300`).bind(kind, kind, level, level, student, student, text, text).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(showcaseRow) })
}

async function getShowcaseEntry(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const v = await c.db.prepare(`${showcaseSelect} WHERE a.id = ?`).bind(entry).first<Record<string, unknown>>()
  if (!v) throw notFound()
  const media = await c.db.prepare(`SELECT m.id, m.file_id, f.original_name AS file_name, m.external_url, m.caption, m.sort_order
      FROM achievement_media m
      LEFT JOIN files f ON f.id = m.file_id AND f.deleted_at IS NULL
      WHERE m.achievement_id = ? ORDER BY m.sort_order, m.created_at`).bind(entry).all<Record<string, unknown>>()
  const out = showcaseRow(v)
  if (media.results.length) out.media = media.results.map(mediaRow)
  return ok(out)
}

function checkEntry(req: Record<string, unknown>, create: boolean): { kind: string; title: string; level: string; awarded: string | null } {
  let kind = typeof req.kind === 'string' ? req.kind : ''
  const title = trim(req.title)
  const level = typeof req.level === 'string' ? req.level : ''
  if (create) {
    if (title === '') throw badRequest('an achievement needs a title')
    if (kind === '') kind = 'award'
    if (!KINDS.has(kind)) throw badRequest(KIND_MSG)
  } else {
    if (title === '') throw badRequest('an achievement needs a title')
    if (kind !== '' && !KINDS.has(kind)) throw badRequest(KIND_MSG)
  }
  if (level !== '' && !LEVELS.has(level)) throw badRequest(LEVEL_MSG)
  const aw = trim(req.awarded_on)
  if (aw !== '' && !isDate(aw)) throw badRequest('awarded_on must be YYYY-MM-DD')
  return { kind, title, level, awarded: aw === '' ? null : aw }
}

async function createShowcaseEntry(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const student = trim(req.student_id)
  if (!isUUID(student)) throw badRequest('student_id must be a uuid')
  const e = checkEntry(req, true)
  const exists = await c.db.prepare(`SELECT 1 AS x FROM students WHERE id = ?`).bind(student).first()
  if (!exists) throw notFound()
  const id = uuid(), t = now()
  await asBadRequest(c.db.prepare(`INSERT INTO student_achievements
        (id, institution_id, student_id, kind, title, description, showcase_note, level, "position", awarded_on, recorded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?)`)
    .bind(id, institutionId(c), student, e.kind, e.title, trim(req.description), trim(req.showcase_note), e.level,
      trim(req.position), e.awarded, c.id.userId || null, t, t).run())
  return created({ id })
}

async function updateShowcaseEntry(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const e = checkEntry(req, false)
  const res = await asBadRequest(c.db.prepare(`UPDATE student_achievements
      SET kind = COALESCE(NULLIF(?1, ''), kind), title = ?2, description = NULLIF(?3, ''), showcase_note = NULLIF(?4, ''),
          level = NULLIF(?5, ''), "position" = NULLIF(?6, ''), awarded_on = ?7,
          is_published = CASE WHEN title <> ?2 THEN 0 ELSE is_published END,
          published_at = CASE WHEN title <> ?2 THEN NULL ELSE published_at END,
          published_by = CASE WHEN title <> ?2 THEN NULL ELSE published_by END,
          updated_at = ?8
      WHERE id = ?9`)
    .bind(e.kind, e.title, trim(req.description), trim(req.showcase_note), e.level, trim(req.position), e.awarded, now(), entry).run())
  if (!res.meta.changes) throw notFound()
  return ok({ updated: true })
}

async function deleteShowcaseEntry(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  // achievement_media cascades in Postgres; deleted explicitly here so the
  // outcome does not depend on D1's foreign-key enforcement.
  const [, del] = await asBadRequest(c.db.batch([
    c.db.prepare(`DELETE FROM achievement_media WHERE achievement_id = ?`).bind(entry),
    c.db.prepare(`DELETE FROM student_achievements WHERE id = ?`).bind(entry),
  ]))
  if (!del.meta.changes) throw notFound()
  return ok({ deleted: true })
}

async function addShowcaseMedia(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const url = trim(req.external_url)
  const fileRef = trim(req.file_id)
  if ((fileRef === '') === (url === '')) throw badRequest('attach exactly one of file_id (upload it first) or external_url')
  let file: string | null = null
  if (fileRef !== '') {
    if (!isUUID(fileRef)) throw badRequest('file_id must be a uuid')
    file = fileRef
  }
  const exists = await c.db.prepare(`SELECT 1 AS x FROM student_achievements WHERE id = ?`).bind(entry).first()
  if (!exists) throw notFound()
  if (file) {
    const live = await c.db.prepare(`SELECT 1 AS x FROM files WHERE id = ? AND deleted_at IS NULL`).bind(file).first()
    if (!live) throw badRequest('that file has been deleted')
  }
  const dup = await c.db.prepare(`SELECT 1 AS x FROM achievement_media WHERE achievement_id = ?
      AND COALESCE(file_id, '00000000-0000-0000-0000-000000000000') = COALESCE(?, '00000000-0000-0000-0000-000000000000')
      AND COALESCE(trim(external_url), '') = COALESCE(trim(NULLIF(?, '')), '')`).bind(entry, file, url).first()
  if (dup) throw badRequest('that picture is already attached to this achievement')
  const id = uuid()
  try {
    await c.db.prepare(`INSERT INTO achievement_media (id, institution_id, achievement_id, file_id, external_url, caption, sort_order, added_by, created_at)
        VALUES (?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?)`)
      .bind(id, institutionId(c), entry, file, url, trim(req.caption), optInt(req.sort_order) ?? 0, c.id.userId || null, now()).run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/UNIQUE constraint/i.test(msg)) throw badRequest('that picture is already attached to this achievement')
    throw badRequest(msg)
  }
  return created({ id })
}

async function removeShowcaseMedia(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const media = c.params.mediaID
  if (!isUUID(media)) throw badRequest('mediaID must be a uuid')
  const res = await asBadRequest(c.db.prepare(`DELETE FROM achievement_media WHERE id = ? AND achievement_id = ?`).bind(media, entry).run())
  if (!res.meta.changes) throw notFound()
  return ok({ removed: true })
}

async function recordShowcaseConsent(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const basis = trim(req.basis)
  if (!BASES.has(basis)) {
    throw badRequest('basis must be admission_form, signed_consent_form, portal_confirmation, recorded_verbal or staff_child')
  }
  const t = now()
  const res = await asBadRequest(c.db.prepare(`UPDATE student_achievements
      SET consent_basis = ?, consent_confirmed_by = ?, consent_confirmed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(basis, c.id.userId || null, t, t, entry).run())
  if (!res.meta.changes) throw notFound()
  return ok({ recorded: true })
}

async function publishShowcaseEntry(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const row = await c.db.prepare(`SELECT consent_confirmed_at FROM student_achievements WHERE id = ?`).bind(entry)
    .first<{ consent_confirmed_at: string | null }>()
  if (!row) throw notFound()
  if (!row.consent_confirmed_at) throw forbidden("record the parent's confirmation before publishing this child's name and photograph")
  const t = now()
  // The consent check rides in the statement too, standing in for the
  // student_achievements_publish_needs_consent CHECK.
  await asBadRequest(c.db.prepare(`UPDATE student_achievements SET is_published = 1, published_at = ?, published_by = ?, updated_at = ?
      WHERE id = ? AND consent_confirmed_at IS NOT NULL`).bind(t, c.id.userId || null, t, entry).run())
  return ok({ published: true })
}

async function unpublishShowcaseEntry(c: Ctx): Promise<Response> {
  const entry = entryParam(c)
  const res = await asBadRequest(c.db.prepare(`UPDATE student_achievements SET is_published = 0, published_at = NULL, published_by = NULL, updated_at = ?
      WHERE id = ?`).bind(now(), entry).run())
  if (!res.meta.changes) throw notFound()
  return ok({ published: false })
}

export function registerShowcase(r: Router): void {
  const also = (perm: string, h: (c: Ctx) => Promise<Response>) => async (c: Ctx) => { requirePerm(c, READ); requirePerm(c, perm); return h(c) }
  r.get('/comms/achievements', READ, listShowcase)
  r.post('/comms/achievements', WRITE, also(WRITE, createShowcaseEntry))
  r.get('/comms/achievements/{id}', READ, getShowcaseEntry)
  r.put('/comms/achievements/{id}', WRITE, also(WRITE, updateShowcaseEntry))
  r.del('/comms/achievements/{id}', WRITE, also(WRITE, deleteShowcaseEntry))
  r.post('/comms/achievements/{id}/media', WRITE, also(WRITE, addShowcaseMedia))
  r.del('/comms/achievements/{id}/media/{mediaID}', WRITE, also(WRITE, removeShowcaseMedia))
  r.post('/comms/achievements/{id}/consent', WRITE, also(WRITE, recordShowcaseConsent))
  r.post('/comms/achievements/{id}/publish', PUBLISH, also(PUBLISH, publishShowcaseEntry))
  r.post('/comms/achievements/{id}/unpublish', PUBLISH, also(PUBLISH, unpublishShowcaseEntry))
}
