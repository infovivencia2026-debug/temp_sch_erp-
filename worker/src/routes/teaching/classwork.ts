import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound, ok, readJSON, now, uuid, int, bool } from '../../http'
import { fullName, institutionId, marks, js, requirePerm, resolveScope, studentPredicate, todayIST, type Scope } from './common'

/* Port of the classwork half of internal/api/teaching.go (subjects,
   assignments and submissions, study materials, live virtual classes) and the
   helpers it borrows from media_library.go. */

const TS = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`
const omitNull = <T extends Record<string, unknown>>(o: T): T => { for (const k of Object.keys(o)) if (o[k] === null) delete o[k]; return o }
const nz = (v: unknown): string | null => { const t = typeof v === 'string' ? v.trim() : ''; return t === '' ? null : t }

/** taughtSubjectsPredicate: class-subjects of a class the caller has a section in. */
function taughtSubjectsPredicate(s: Scope, alias: string): { sql: string; args: string[] } {
  if (s.allStudents) return { sql: '1', args: [] }
  if (!s.sectionIds.length) return { sql: '0', args: [] }
  return { sql: `EXISTS (SELECT 1 FROM sections tsec WHERE tsec.id IN (${marks(s.sectionIds)}) AND tsec.class_id = ${alias}.class_id)`, args: [js(s.sectionIds)] }
}
export const reachesSection = (s: Scope, id: string) => s.allStudents || s.sectionIds.includes(id)
export async function classSubjectTaught(c: Ctx, s: Scope, csId: string): Promise<boolean> {
  if (s.allStudents) return true
  if (!s.sectionIds.length) return false
  const r = await c.db.prepare(`SELECT 1 AS ok FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id WHERE cs.id = ? AND sec.id IN (${marks(s.sectionIds)}) LIMIT 1`)
    .bind(csId, js(s.sectionIds)).first()
  return !!r
}
async function reachesTaughtStudent(c: Ctx, s: Scope, studentId: string): Promise<boolean> {
  if (s.allStudents) return true
  if (!s.sectionIds.length) return false
  const r = await c.db.prepare(`SELECT 1 AS ok FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' AND e.section_id IN (${marks(s.sectionIds)}) LIMIT 1`)
    .bind(studentId, js(s.sectionIds)).first()
  return !!r
}
async function studentsInReach(c: Ctx, s: Scope, ids: string[]): Promise<boolean> {
  if (s.allStudents) return true
  const p = studentPredicate(s, 'st')
  const r = await c.db.prepare(`SELECT count(*) AS n FROM students st WHERE st.id IN (${marks(ids)}) AND ${p.sql}`).bind(js(ids), ...p.args).first<{ n: number }>()
  return (r?.n ?? 0) === ids.length
}
async function materialInReach(c: Ctx, s: Scope, csId: string | null, secId: string | null): Promise<boolean> {
  if (s.allStudents) return true
  if (csId && (await classSubjectTaught(c, s, csId))) return true
  if (secId && reachesSection(s, secId)) return true
  return false
}
/** materialOwnedOrInReach: null when the material does not exist, false when out of reach. */
async function materialOwnedOrInReach(c: Ctx, s: Scope, id: string): Promise<boolean | null> {
  const m = await c.db.prepare(`SELECT class_subject_id, section_id, uploaded_by FROM study_materials WHERE id = ?`).bind(id)
    .first<{ class_subject_id: string | null; section_id: string | null; uploaded_by: string | null }>()
  if (!m) return null
  if (m.uploaded_by && m.uploaded_by === s.userId) return true
  return materialInReach(c, s, m.class_subject_id, m.section_id)
}

const MATERIAL_KINDS = new Set(['note', 'worksheet', 'reference', 'video', 'link', 'syllabus'])
const MATERIAL_AUDIENCES = new Set(['class', 'school', 'students'])
const MEETING_PROVIDERS = new Set(['zoom', 'google_meet', 'ms_teams'])
const VC_STATUSES = new Set(['provider_pending', 'scheduled', 'live', 'ended', 'cancelled'])

export function registerClasswork(r: Router) {
  const P = 'academics.timetable.read'
  const HW = 'academics.homework.write'

  r.get('/teaching/subjects', P, async (c) => {
    const s = await resolveScope(c)
    const w = taughtSubjectsPredicate(s, 'cs')
    const rows = await c.db.prepare(`SELECT cs.id AS class_subject_id, cs.class_id, c.name AS class_name, sub.name AS subject, sub.code AS subject_code,
        sub.is_scholastic, cs.max_marks FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
        WHERE ${w.sql} ORDER BY c.level, sub.name`).bind(...w.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, is_scholastic: bool(v.is_scholastic) })) })
  })

  r.get('/teaching/assignments', P, async (c) => {
    const s = await resolveScope(c)
    let filter = s.allStudents ? '1' : `h.section_id IN (${marks(s.sectionIds)})`
    const args: string[] = s.allStudents ? [] : [js(s.sectionIds)]
    const q = (c.url.searchParams.get('section_id') ?? '').trim()
    if (q) {
      if (!isUUID(q)) throw badRequest('section_id must be a uuid')
      if (!reachesSection(s, q)) throw forbidden('assignments for this section')
      filter += ' AND h.section_id = ?'; args.push(q)
    }
    const rows = await c.db.prepare(`SELECT h.id, h.section_id, sec.name AS section, c.name AS class_name, sub.name AS subject, h.kind, h.title, h.instructions,
        h.assigned_on, h.due_on, CAST(h.max_marks AS REAL) AS max_marks, h.is_published, h.allow_submission,
        (SELECT count(*) FROM enrollments e WHERE e.section_id = h.section_id AND e.status = 'active') AS roll,
        (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status IN ('submitted','late','graded')) AS submitted,
        (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status = 'graded') AS graded,
        (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status IN ('submitted','late')) AS awaiting_marking,
        (h.due_on IS NOT NULL AND h.due_on < ?) AS overdue
        FROM homework h JOIN sections sec ON sec.id = h.section_id JOIN classes c ON c.id = sec.class_id
        LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
        WHERE ${filter} ORDER BY h.assigned_on DESC, h.created_at DESC LIMIT 200`).bind(todayIST(), ...args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_published: bool(v.is_published), allow_submission: bool(v.allow_submission), overdue: bool(v.overdue) })) })
  })

  r.get('/teaching/assignments/{id}/submissions', P, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid assignment id')
    const s = await resolveScope(c)
    const hw = await c.db.prepare(`SELECT section_id FROM homework WHERE id = ?`).bind(c.params.id).first<{ section_id: string }>()
    if (!hw) throw notFound()
    if (!reachesSection(s, hw.section_id)) throw notFound()
    const rows = await c.db.prepare(`SELECT st.id AS student_id, st.admission_no, trim(st.first_name || COALESCE(' ' || st.last_name, '')) AS full_name, e.roll_no,
        hs.id AS submission_id, COALESCE(hs.status, 'pending') AS status, ${TS('hs.submitted_at')} AS submitted_at, hs.text_answer, hs.file_id,
        CAST(hs.marks AS REAL) AS marks, hs.feedback, u.full_name AS graded_by, ${TS('hs.graded_at')} AS graded_at, COALESCE(hs.status = 'late', 0) AS late
        FROM enrollments e JOIN students st ON st.id = e.student_id
        LEFT JOIN homework_submissions hs ON hs.homework_id = ? AND hs.student_id = st.id LEFT JOIN users u ON u.id = hs.graded_by
        WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no NULLS LAST, st.first_name`).bind(c.params.id, hw.section_id).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, late: bool(v.late) })) })
  })

  r.post('/teaching/assignments/{id}/grade', P, async (c) => {
    requirePerm(c, HW)
    if (!isUUID(c.params.id)) throw badRequest('invalid assignment id')
    const req = await readJSON<{ entries?: { student_id: string; marks?: number | null; feedback?: string; status?: string }[] }>(c.req)
    if (!req.entries?.length) throw badRequest('entries must not be empty')
    const s = await resolveScope(c)
    const hw = await c.db.prepare(`SELECT section_id, max_marks FROM homework WHERE id = ?`).bind(c.params.id).first<{ section_id: string; max_marks: string | null }>()
    if (!hw) throw notFound()
    if (!reachesSection(s, hw.section_id)) throw forbidden('marking work for this child')
    const maxMarks = hw.max_marks === null ? null : Number(hw.max_marks)
    const stmts: D1PreparedStatement[] = []
    for (const e of req.entries) {
      if (!isUUID(e.student_id)) throw new HttpError(500, 'internal')
      if (!(await reachesTaughtStudent(c, s, e.student_id))) throw forbidden('marking work for this child')
      const m = typeof e.marks === 'number' ? e.marks : null
      if (m !== null && maxMarks !== null && (m < 0 || m > maxMarks)) throw badRequest('a mark may not exceed the assignment maximum')
      const status = (e.status ?? '').trim() || 'graded'
      if (!['graded', 'resubmit', 'submitted', 'late', 'pending'].includes(status)) throw badRequest('status must be graded, resubmit, submitted, late or pending')
      stmts.push(c.db.prepare(`INSERT INTO homework_submissions (id, institution_id, homework_id, student_id, status, marks, feedback, graded_by, graded_at)
          VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?)
          ON CONFLICT (homework_id, student_id) DO UPDATE SET status = excluded.status, marks = excluded.marks, feedback = excluded.feedback, graded_by = excluded.graded_by, graded_at = excluded.graded_at`)
        .bind(uuid(), institutionId(c), c.params.id, e.student_id, status, m === null ? null : String(m), e.feedback ?? '', c.id.userId, now()))
    }
    await c.db.batch(stmts)
    return ok({ graded: stmts.length })
  })

  r.get('/teaching/materials', P, async (c) => {
    const s = await resolveScope(c)
    const w = taughtSubjectsPredicate(s, 'cs')
    const args: string[] = [...w.args]
    let sectionArm = '0'
    if (s.allStudents) sectionArm = '1'
    else if (s.sectionIds.length) { sectionArm = `sm.section_id IN (${marks(s.sectionIds)})` }
    const secArgs = s.allStudents || !s.sectionIds.length ? [] : [js(s.sectionIds)]
    const rows = await c.db.prepare(`SELECT sm.id, sm.class_subject_id, sm.section_id, c.name AS class_name, sub.name AS subject, sec.name AS section,
        sm.title, sm.description, sm.kind, sm.file_id, f.original_name AS file_name, f.size_bytes, sm.external_url, sm.is_published, u.full_name AS uploaded_by,
        ${TS('sm.created_at')} AS created_at, sm.audience,
        (SELECT count(*) FROM study_material_targets t WHERE t.material_id = sm.id) AS targets,
        (SELECT count(*) FROM study_material_views v WHERE v.material_id = sm.id) AS views,
        f.content_type, ${TS('sm.expires_at')} AS expires_at
        FROM study_materials sm LEFT JOIN class_subjects cs ON cs.id = sm.class_subject_id LEFT JOIN classes c ON c.id = cs.class_id
        LEFT JOIN subjects sub ON sub.id = cs.subject_id LEFT JOIN sections sec ON sec.id = sm.section_id LEFT JOIN files f ON f.id = sm.file_id LEFT JOIN users u ON u.id = sm.uploaded_by
        WHERE (sm.class_subject_id IS NOT NULL AND ${w.sql})
           OR (sm.class_subject_id IS NULL AND sm.section_id IS NOT NULL AND ${sectionArm})
           OR (sm.class_subject_id IS NULL AND sm.section_id IS NULL AND (${sectionArm} OR sm.uploaded_by = ?))
           OR sm.uploaded_by = ?
        ORDER BY sm.created_at DESC LIMIT 300`).bind(...args, ...secArgs, ...secArgs, s.userId, s.userId).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_published: bool(v.is_published) })) })
  })

  r.get('/teaching/materials/{id}/views', P, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid material id')
    const s = await resolveScope(c)
    if (!(await materialOwnedOrInReach(c, s, c.params.id))) throw notFound()
    const rows = await c.db.prepare(`SELECT u.full_name AS name, CASE WHEN st.id IS NULL THEN NULL ELSE ${fullName('st')} END AS student, ${TS('v.viewed_at')} AS viewed_at
        FROM study_material_views v JOIN users u ON u.id = v.user_id LEFT JOIN students st ON st.id = v.student_id
        WHERE v.material_id = ? ORDER BY v.viewed_at DESC LIMIT 500`).bind(c.params.id).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/teaching/materials', P, async (c) => {
    requirePerm(c, HW)
    const req = await readJSON<{ class_subject_id?: string; section_id?: string; title?: string; description?: string; kind?: string; file_id?: string; external_url?: string; is_published?: boolean; audience?: string; student_ids?: string[]; expires_in_days?: number }>(c.req)
    const title = (req.title ?? '').trim()
    if (!title) throw badRequest('title is required')
    const kind = req.kind || 'note'
    if (!MATERIAL_KINDS.has(kind)) throw badRequest('kind must be note, worksheet, reference, video, link or syllabus')
    if (!nz(req.file_id) && !nz(req.external_url)) throw badRequest('give either an uploaded file_id or an external_url, file storage is unconfigured on this deployment, so a link is the working option')
    let csRaw = req.class_subject_id ?? '', secRaw = req.section_id ?? ''
    let audience = req.audience ?? ''
    if (!audience) audience = (req.student_ids?.length ?? 0) > 0 ? 'students' : (!csRaw && !secRaw ? 'school' : 'class')
    if (!MATERIAL_AUDIENCES.has(audience)) throw badRequest('audience must be class, school or students')
    if (audience === 'class' && !csRaw && !secRaw) throw badRequest('name the class_subject_id or the section_id this is for')
    let targets: string[] = []
    if (audience === 'students') {
      for (const v of req.student_ids ?? []) { if (!isUUID(v)) throw badRequest('student_ids must be uuids'); if (!targets.includes(v)) targets.push(v) }
      if (!targets.length) throw badRequest('name at least one student')
      csRaw = ''; secRaw = ''
    }
    const s = await resolveScope(c)
    if (audience === 'school' && !s.allStudents) throw forbidden('sharing with the whole school')
    let csId: string | null = null, secId: string | null = null
    if (csRaw) { if (!isUUID(csRaw)) throw badRequest('class_subject_id must be a uuid'); csId = csRaw }
    if (secRaw) {
      if (!isUUID(secRaw)) throw badRequest('section_id must be a uuid')
      if (!reachesSection(s, secRaw)) throw forbidden('sharing material with this section')
      secId = secRaw
    }
    if (csId && !(await classSubjectTaught(c, s, csId))) throw forbidden('sharing material for this subject')
    if (targets.length && !(await studentsInReach(c, s, targets))) throw forbidden('one or more of these students is not in a class you teach')
    const published = typeof req.is_published === 'boolean' ? req.is_published : true
    const days = typeof req.expires_in_days === 'number' && req.expires_in_days > 0 ? req.expires_in_days : null
    const expires = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString()
    const id = uuid(), inst = institutionId(c)
    const stmts = [c.db.prepare(`INSERT INTO study_materials (id, institution_id, class_subject_id, section_id, title, description, kind, file_id, external_url, is_published, uploaded_by, audience, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?)`)
      .bind(id, inst, csId, secId, title, req.description ?? '', kind, nz(req.file_id), req.external_url ?? '', int(published), c.id.userId, audience, expires, now())]
    for (const t of targets) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO study_material_targets (id, institution_id, material_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(uuid(), inst, id, t, now()))
    await c.db.batch(stmts)
    return ok({ id })
  })

  r.put('/teaching/materials/{id}', P, async (c) => {
    requirePerm(c, HW)
    if (!isUUID(c.params.id)) throw badRequest('invalid material id')
    const req = await readJSON<{ title?: string; description?: string; kind?: string; external_url?: string; is_published?: boolean }>(c.req)
    if (req.kind && !MATERIAL_KINDS.has(req.kind)) throw badRequest('kind must be note, worksheet, reference, video, link or syllabus')
    const s = await resolveScope(c)
    if (!(await materialOwnedOrInReach(c, s, c.params.id))) throw notFound()
    const res = await c.db.prepare(`UPDATE study_materials SET title = COALESCE(NULLIF(?, ''), title), description = COALESCE(NULLIF(?, ''), description), kind = COALESCE(NULLIF(?, ''), kind),
        external_url = COALESCE(NULLIF(?, ''), external_url), is_published = COALESCE(?, is_published) WHERE id = ?`)
      .bind((req.title ?? '').trim(), req.description ?? '', req.kind ?? '', req.external_url ?? '', typeof req.is_published === 'boolean' ? int(req.is_published) : null, c.params.id).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id: c.params.id })
  })

  r.get('/teaching/virtual-classes/providers', P, async (c) => {
    const rows = await c.db.prepare(`SELECT id, provider, display_name, account_ref, is_active FROM virtual_class_providers ORDER BY provider`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_active: bool(v.is_active), integrated: false })) })
  })

  r.post('/teaching/virtual-classes/providers', P, async (c) => {
    requirePerm(c, 'institution.integrations.write')
    const req = await readJSON<{ provider?: string; display_name?: string; account_ref?: string; is_active?: boolean }>(c.req)
    if (!req.provider || !MEETING_PROVIDERS.has(req.provider)) throw badRequest('provider must be zoom, google_meet or ms_teams')
    const name = (req.display_name ?? '').trim()
    if (!name) throw badRequest('display_name is required')
    const active = typeof req.is_active === 'boolean' ? req.is_active : true
    const inst = institutionId(c)
    const ex = await c.db.prepare(`SELECT id FROM virtual_class_providers WHERE institution_id = ? AND provider = ?`).bind(inst, req.provider).first<{ id: string }>()
    let id = ex?.id
    if (id) {
      await c.db.prepare(`UPDATE virtual_class_providers SET display_name = ?, account_ref = ?, is_active = ?, configured_by = ? WHERE id = ?`).bind(name, nz(req.account_ref), int(active), c.id.userId, id).run()
    } else {
      id = uuid()
      await c.db.prepare(`INSERT INTO virtual_class_providers (id, institution_id, provider, display_name, account_ref, is_active, configured_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, req.provider, name, nz(req.account_ref), int(active), c.id.userId, now()).run()
    }
    return ok({ id, provider: req.provider, integration_status: 'blocked: no meeting API is wired to this provider yet' })
  })

  r.get('/teaching/virtual-classes', P, async (c) => {
    const s = await resolveScope(c)
    let where = '0'; const args: string[] = []
    if (s.allStudents) where = '1'
    else if (s.sectionIds.length) { where = `v.section_id IN (${marks(s.sectionIds)})`; args.push(js(s.sectionIds)) }
    const rows = await c.db.prepare(`SELECT v.id, v.section_id, sec.name AS section, c.name AS class_name, sub.name AS subject, p.provider, p.display_name AS provider_name,
        v.topic, v.agenda, ${TS('v.scheduled_at')} AS scheduled_at, v.duration_minutes, v.join_url, v.status, ${TS('v.started_at')} AS started_at, u.full_name AS created_by,
        (v.join_url IS NOT NULL) AS joinable
        FROM virtual_class_sessions v JOIN sections sec ON sec.id = v.section_id JOIN classes c ON c.id = sec.class_id
        LEFT JOIN class_subjects cs ON cs.id = v.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN virtual_class_providers p ON p.id = v.provider_id LEFT JOIN users u ON u.id = v.created_by
        WHERE ${where} ORDER BY v.scheduled_at DESC LIMIT 200`).bind(...args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, joinable: bool(v.joinable) })) })
  })

  r.post('/teaching/virtual-classes', P, async (c) => {
    requirePerm(c, HW)
    const req = await readJSON<{ section_id?: string; class_subject_id?: string; provider_id?: string; topic?: string; agenda?: string; scheduled_at?: string; duration_minutes?: number; join_url?: string; status?: string }>(c.req)
    if (!isUUID(req.section_id)) throw badRequest('section_id must be a uuid')
    const topic = (req.topic ?? '').trim()
    if (!topic) throw badRequest('topic is required')
    if (!nz(req.scheduled_at)) throw badRequest('scheduled_at is required')
    const duration = typeof req.duration_minutes === 'number' && req.duration_minutes > 0 ? req.duration_minutes : 40
    const s = await resolveScope(c)
    if (!reachesSection(s, req.section_id)) throw forbidden('scheduling a live class for this section')
    const status = nz(req.join_url) ? 'scheduled' : 'provider_pending'
    const csId = nz(req.class_subject_id)
    if (csId) {
      if (!isUUID(csId)) throw new HttpError(500, 'internal')
      if (!(await classSubjectTaught(c, s, csId))) throw forbidden('scheduling a live class for this subject')
    }
    const sched = new Date(req.scheduled_at!)
    if (Number.isNaN(sched.getTime())) throw new HttpError(500, 'internal')
    const id = uuid(), ts = now()
    await c.db.prepare(`INSERT INTO virtual_class_sessions (id, institution_id, section_id, class_subject_id, provider_id, topic, agenda, scheduled_at, duration_minutes, join_url, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?, ?, ?)`)
      .bind(id, institutionId(c), req.section_id, csId, nz(req.provider_id), topic, req.agenda ?? '', sched.toISOString(), duration, req.join_url ?? '', status, c.id.userId, ts, ts).run()
    const out: Record<string, unknown> = { id, status }
    if (status === 'provider_pending') out.note = 'no meeting created: no provider integration is wired. Paste a join_url to make this session joinable.'
    return ok(out)
  })

  r.put('/teaching/virtual-classes/{id}', P, async (c) => {
    requirePerm(c, HW)
    if (!isUUID(c.params.id)) throw badRequest('invalid session id')
    const req = await readJSON<{ topic?: string; agenda?: string; join_url?: string; status?: string }>(c.req)
    if (req.status && !VC_STATUSES.has(req.status)) throw badRequest('status must be provider_pending, scheduled, live, ended or cancelled')
    const s = await resolveScope(c)
    const row = await c.db.prepare(`SELECT section_id, join_url FROM virtual_class_sessions WHERE id = ?`).bind(c.params.id).first<{ section_id: string; join_url: string | null }>()
    if (!row || !reachesSection(s, row.section_id)) throw notFound()
    // virtual_class_sessions_joinable: scheduled/live need a join_url (a CHECK constraint in Postgres).
    const newStatus = req.status || null
    if ((newStatus === 'scheduled' || newStatus === 'live') && !nz(req.join_url) && !row.join_url) throw badRequest('a session cannot be scheduled or live without a join_url')
    const res = await c.db.prepare(`UPDATE virtual_class_sessions SET topic = COALESCE(NULLIF(?, ''), topic), agenda = COALESCE(NULLIF(?, ''), agenda), join_url = COALESCE(NULLIF(?, ''), join_url),
        status = COALESCE(NULLIF(?, ''), status), ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END, updated_at = ? WHERE id = ?`)
      .bind(req.topic ?? '', req.agenda ?? '', req.join_url ?? '', req.status ?? '', req.status ?? '', now(), now(), c.params.id).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id: c.params.id })
  })

  r.post('/teaching/virtual-classes/{id}/launch', P, async (c) => {
    requirePerm(c, HW)
    if (!isUUID(c.params.id)) throw badRequest('invalid session id')
    const s = await resolveScope(c)
    const row = await c.db.prepare(`SELECT section_id, join_url, status FROM virtual_class_sessions WHERE id = ?`).bind(c.params.id).first<{ section_id: string; join_url: string | null; status: string }>()
    if (!row || !reachesSection(s, row.section_id)) throw notFound()
    if (row.join_url === null) throw new HttpError(503, 'no meeting provider is integrated, so no join link can be created. Create the meeting in Zoom or Meet and save its join_url on this session.', { code: 'provider_unconfigured' })
    await c.db.prepare(`UPDATE virtual_class_sessions SET status = 'live', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`).bind(now(), now(), c.params.id).run()
    return ok({ id: c.params.id, status: 'live', join_url: row.join_url })
  })
}
