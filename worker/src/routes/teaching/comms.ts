import type { Router, Ctx } from '../../router'
import { enqueueMany } from '../../services/jobs'
import { badRequest, created, forbidden, isUUID, notFound, ok, readJSON, now, uuid, uuidParam, int, bool } from '../../http'
import { can } from '../../identity'
import { fullName, institutionId, marks, js, notifyStmt, requireAny, requirePerm, resolveScope, shortName, todayIST, type Scope } from './common'

/* Port of internal/api/faculty_comms.go: what a teacher writes about a child
   (remarks, anecdotal records, report-card remarks, PTM notes, broadcasts)
   and the family's copy of the remarks. */

const ANECDOTAL = 'anecdotal'

async function reachesTaughtStudent(c: Ctx, s: Scope, studentId: string): Promise<boolean> {
  if (s.allStudents) return true
  if (!s.sectionIds.length) return false
  const r = await c.db.prepare(`SELECT 1 AS ok FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' AND e.section_id IN (${marks(s.sectionIds)}) LIMIT 1`)
    .bind(studentId, js(s.sectionIds)).first()
  return !!r
}
async function isClassTeacherOfChild(c: Ctx, studentId: string): Promise<boolean> {
  const r = await c.db.prepare(`SELECT 1 AS ok FROM enrollments e JOIN sections sec ON sec.id = e.section_id
      WHERE e.student_id = ? AND e.status = 'active' AND sec.class_teacher_id = ? LIMIT 1`).bind(studentId, c.id.userId).first()
  return !!r
}
function taughtStudentsPredicate(s: Scope, column: string): { sql: string; args: string[] } {
  if (s.allStudents) return { sql: '1', args: [] }
  if (!s.sectionIds.length) return { sql: '0', args: [] }
  return { sql: `EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = ${column} AND se.status = 'active' AND se.section_id IN (${marks(s.sectionIds)}))`, args: [js(s.sectionIds)] }
}
const reachesSection = (s: Scope, id: string) => s.allStudents || s.sectionIds.includes(id)
const nul = (v: string | undefined | null) => { const t = (v ?? '').trim(); return t === '' ? null : t }
const omitNull = <T extends Record<string, unknown>>(o: T): T => { for (const k of Object.keys(o)) if (o[k] === null) delete o[k]; return o }

export function registerFacultyComms(r: Router) {
  const P = 'academics.timetable.read'

  r.get('/teaching/terms', P, async (c) => {
    const rows = await c.db.prepare(`SELECT t.id, t.name, ay.name AS academic_year, t.starts_on, t.ends_on, t.sequence,
        (? BETWEEN t.starts_on AND t.ends_on) AS is_current FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id
        ORDER BY t.starts_on DESC, t.sequence`).bind(todayIST()).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, is_current: bool(v.is_current) })) })
  })

  r.get('/teaching/remarks', P, async (c) => {
    const s = await resolveScope(c)
    const q = c.url.searchParams
    const sid = nul(q.get('student_id')), sec = nul(q.get('section_id')), kind = nul(q.get('kind'))
    const pred = taughtStudentsPredicate(s, 'sr.student_id')
    const rows = await c.db.prepare(`SELECT sr.id, sr.student_id, st.admission_no, ${fullName('st')} AS student_name,
        c.name AS class_name, sec.name AS section_name, sub.name AS subject, t.name AS term, sr.kind, sr.body,
        NOT sr.visible_to_family AS private, sr.observed_on, substr(sr.created_at,1,16) AS recorded_at, u.full_name AS recorded_by,
        sr.recorded_by = ? AS mine
        FROM student_remarks sr JOIN students st ON st.id = sr.student_id
        LEFT JOIN sections sec ON sec.id = sr.section_id LEFT JOIN classes c ON c.id = sec.class_id
        LEFT JOIN class_subjects cs ON cs.id = sr.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN terms t ON t.id = sr.term_id LEFT JOIN users u ON u.id = sr.recorded_by
        WHERE (? IS NULL OR sr.student_id = ?) AND (? IS NULL OR sr.section_id = ?) AND (? IS NULL OR sr.kind = ?) AND ${pred.sql}
        ORDER BY sr.observed_on DESC, sr.created_at DESC LIMIT 300`)
      .bind(c.id.userId, sid, sid, sec, sec, kind, kind, ...pred.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, private: bool(v.private), mine: bool(v.mine) })) })
  })

  r.post('/teaching/remarks', P, async (c) => {
    requireAny(c, 'welfare.discipline.write', 'comms.announcements.write')
    const req = await readJSON<{ student_id?: string; class_subject_id?: string; term_id?: string; kind?: string; body?: string; private?: boolean; observed_on?: string }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    const body = (req.body ?? '').trim()
    if (!body) throw badRequest('a remark needs something written in it')
    const kind = req.kind || 'academic'
    let priv = kind === ANECDOTAL
    if (!priv && typeof req.private === 'boolean') priv = req.private
    const s = await resolveScope(c)
    if (!(await reachesTaughtStudent(c, s, req.student_id))) throw notFound()
    let subjectId: string | null = null
    if (req.class_subject_id) {
      if (!isUUID(req.class_subject_id)) throw badRequest('class_subject_id must be a uuid')
      const t = await c.db.prepare(`SELECT 1 AS ok FROM class_subjects cs JOIN enrollments e ON e.class_id = cs.class_id
          WHERE cs.id = ? AND e.student_id = ? AND e.status = 'active' LIMIT 1`).bind(req.class_subject_id, req.student_id).first()
      if (!t) throw badRequest('that subject is not taught to this child')
      subjectId = req.class_subject_id
    }
    const id = uuid(), ts = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO student_remarks (id, institution_id, student_id, section_id, class_subject_id, term_id, kind, body, visible_to_family, observed_on, recorded_by, created_at, updated_at)
        SELECT ?, ?, ?, (SELECT e.section_id FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1),
               ?, ?, ?, ?, ?, COALESCE(?, ?), ?, ?, ?`)
        .bind(id, institutionId(c), req.student_id, req.student_id, subjectId, nul(req.term_id), kind, body, int(!priv), nul(req.observed_on), todayIST(), c.id.userId, ts, ts),
    ]
    let remarkMail: { type: string; institution_id: string; payload: Record<string, unknown> }[] = []
    if (!priv) {
      // notifyGuardiansOfRemark: the in-app alert and the student.remark email for every guardian with a login and the child.
      const child = await c.db.prepare(`SELECT ${shortName('students')} AS n FROM students WHERE id = ?`).bind(req.student_id).first<{ n: string }>()
      const people = await c.db.prepare(`SELECT g.user_id AS id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND g.user_id IS NOT NULL
          UNION SELECT st.user_id FROM students st WHERE st.id = ? AND st.user_id IS NOT NULL`).bind(req.student_id, req.student_id).all<{ id: string }>()
      const childName = child?.n ?? ''
      let summary = body
      if (summary.length > 240) summary = summary.slice(0, 237) + '…'
      let title = 'A note about ' + childName
      if (kind === 'achievement') title = childName + ' was commended'
      else if (kind === 'concern' || kind === 'behaviour') title = 'About ' + childName + '’s conduct'
      for (const p of people.results) stmts.push(notifyStmt(c, p.id, req.student_id, 'student_remark', title, summary + ' - ' + c.id.fullName, '/go/remarks', 'student_remark', id))
      const d = new Date(Date.now() + 330 * 60_000)
      const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      const onDate = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
      remarkMail = people.results.map((p) => ({ type: 'message:send', institution_id: institutionId(c),
        payload: { institution_id: institutionId(c), channel: 'email', template_key: 'student.remark', to_user_id: p.id, job_id: uuid(),
          vars: { title, summary: body, teacher: c.id.fullName, on_date: onDate } } }))
    }
    await c.db.batch(stmts)
    // The email leg (Go: TypeMessageSend student.remark); a failure is logged, the remark stands.
    if (remarkMail.length) { try { await enqueueMany(c.env, remarkMail) } catch (e) { console.warn('remark email not queued', e) } }
    return created({ id, private: priv, kind })
  })

  r.put('/teaching/remarks/{id}', P, async (c) => {
    requireAny(c, 'welfare.discipline.write', 'comms.announcements.write')
    if (!isUUID(c.params.id)) throw badRequest('invalid remark id')
    const req = await readJSON<{ body?: string; private?: boolean }>(c.req)
    const body = (req.body ?? '').trim()
    if (!body) throw badRequest('a remark needs something written in it')
    const vis = typeof req.private === 'boolean' ? int(!req.private) : null
    const res = await c.db.prepare(`UPDATE student_remarks SET body = ?, visible_to_family = CASE WHEN kind = ? THEN 0 ELSE COALESCE(?, visible_to_family) END, updated_at = ?
        WHERE id = ? AND recorded_by = ?`).bind(body, ANECDOTAL, vis, now(), c.params.id, c.id.userId).run()
    if (res.meta.changes !== 1) throw notFound()
    return ok({ updated: true })
  })

  r.get('/teaching/report-remarks', P, async (c) => {
    const s = await resolveScope(c)
    const rawSection = c.url.searchParams.get('section_id') ?? '', rawTerm = c.url.searchParams.get('term_id') ?? ''
    if (rawSection === '' && rawTerm === '') return ok({ items: [], needs: ['section_id', 'term_id'], sections: s.sectionIds })
    if (!isUUID(rawSection)) throw badRequest('section_id must be a uuid')
    if (!isUUID(rawTerm)) throw badRequest('term_id must be a uuid. A remark with no term cannot be printed on the right card')
    if (!reachesSection(s, rawSection)) throw notFound()
    const rows = await c.db.prepare(`SELECT st.id AS student_id, st.admission_no, ${fullName('st')} AS student_name, e.roll_no,
        rc.class_teacher_remarks AS class_teacher_remark, ctu.full_name AS class_teacher_remark_by, substr(rc.class_teacher_remarks_at,1,10) AS class_teacher_remark_at,
        rc.principal_remarks AS principal_remark, pu.full_name AS principal_remark_by, substr(rc.principal_remarks_at,1,10) AS principal_remark_at,
        rc.id IS NOT NULL AS card_exists, COALESCE(rc.is_published, 0) AS is_published,
        nullif(trim(COALESCE(rc.class_teacher_remarks,'')),'') IS NOT NULL AS has_term_remarks
        FROM enrollments e JOIN students st ON st.id = e.student_id
        LEFT JOIN report_cards rc ON rc.id = (SELECT r2.id FROM report_cards r2 LEFT JOIN exams ex ON ex.id = r2.exam_id
             WHERE r2.student_id = st.id AND r2.term_id = ?
             ORDER BY (r2.class_teacher_remarks IS NOT NULL OR r2.principal_remarks IS NOT NULL) DESC, (ex.kind = 'term') DESC NULLS LAST, ex.starts_on DESC NULLS LAST LIMIT 1)
        LEFT JOIN users ctu ON ctu.id = rc.class_teacher_remarks_by LEFT JOIN users pu ON pu.id = rc.principal_remarks_by
        WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no NULLS LAST, st.admission_no`).bind(rawTerm, rawSection).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, card_exists: bool(v.card_exists), is_published: bool(v.is_published), has_term_remarks: bool(v.has_term_remarks) })) })
  })

  r.put('/teaching/report-remarks', P, async (c) => {
    requireAny(c, 'welfare.discipline.write', 'comms.announcements.write')
    const req = await readJSON<{ student_id?: string; term_id?: string; class_teacher_remark?: string | null; principal_remark?: string | null }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    if (!isUUID(req.term_id)) throw badRequest('term_id must be a uuid. A remark with no term cannot be printed on the right card')
    const remark = typeof req.class_teacher_remark === 'string' ? req.class_teacher_remark : null
    const principal = typeof req.principal_remark === 'string' ? req.principal_remark : null
    if (remark === null && principal === null) throw badRequest('nothing to save')
    const canGenerate = can(c.id, 'academics.reportcards.generate')
    if (principal !== null && !canGenerate) throw forbidden("the principal's summary comment is written by the office that issues the card")
    const s = await resolveScope(c)
    if (!(await reachesTaughtStudent(c, s, req.student_id))) throw notFound()
    if (remark !== null && !canGenerate && !(await isClassTeacherOfChild(c, req.student_id))) throw forbidden("only this child's class teacher writes the remark on their report card")
    const ts = now(), uid = c.id.userId
    const sets = `class_teacher_remarks = COALESCE(?, class_teacher_remarks), class_teacher_remarks_by = CASE WHEN ? IS NOT NULL THEN ? ELSE class_teacher_remarks_by END,
      class_teacher_remarks_at = CASE WHEN ? IS NOT NULL THEN ? ELSE class_teacher_remarks_at END,
      principal_remarks = COALESCE(?, principal_remarks), principal_remarks_by = CASE WHEN ? IS NOT NULL THEN ? ELSE principal_remarks_by END,
      principal_remarks_at = CASE WHEN ? IS NOT NULL THEN ? ELSE principal_remarks_at END`
    const setArgs = [remark, remark, uid, remark, ts, principal, principal, uid, principal, ts]
    const upd = await c.db.prepare(`UPDATE report_cards SET ${sets} WHERE id = (SELECT c.id FROM report_cards c JOIN exams ex ON ex.id = c.exam_id
        WHERE c.student_id = ? AND c.term_id = ? ORDER BY (ex.kind = 'term') DESC, ex.starts_on DESC NULLS LAST LIMIT 1)`).bind(...setArgs, req.student_id, req.term_id).run()
    if (upd.meta.changes > 0) return ok({ saved: true })
    // The remark-only row: one per child per term until the term's card is generated (the partial unique index).
    const term = await c.db.prepare(`SELECT academic_year_id FROM terms WHERE id = ?`).bind(req.term_id).first<{ academic_year_id: string }>()
    if (!term) throw badRequest('unknown term')
    const existing = await c.db.prepare(`SELECT id FROM report_cards WHERE student_id = ? AND academic_year_id = ? AND term_id = ? AND exam_id IS NULL LIMIT 1`)
      .bind(req.student_id, term.academic_year_id, req.term_id).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE report_cards SET ${sets} WHERE id = ?`).bind(...setArgs, existing.id).run()
    } else {
      await c.db.prepare(`INSERT INTO report_cards (id, institution_id, student_id, academic_year_id, term_id, enrollment_id, class_teacher_remarks, class_teacher_remarks_by, class_teacher_remarks_at,
          principal_remarks, principal_remarks_by, principal_remarks_at, created_at)
          VALUES (?, ?, ?, ?, ?, (SELECT e.id FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1), ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), institutionId(c), req.student_id, term.academic_year_id, req.term_id, req.student_id,
          remark, remark !== null ? uid : null, remark !== null ? ts : null, principal, principal !== null ? uid : null, principal !== null ? ts : null, ts).run()
    }
    return ok({ saved: true })
  })

  r.get('/teaching/ptm-notes', P, async (c) => {
    const s = await resolveScope(c)
    const q = c.url.searchParams
    const pending = q.get('pending') !== null && q.get('pending') !== '' && q.get('pending') !== '0' ? 1 : 0
    const sid = nul(q.get('student_id')), sec = nul(q.get('section_id'))
    const pred = taughtStudentsPredicate(s, 'pn.student_id')
    const rows = await c.db.prepare(`SELECT pn.id, pn.student_id, st.admission_no, ${fullName('st')} AS student_name, c.name AS class_name, sec.name AS section_name,
        pn.met_on, pn.attendance, pn.attended_by, pn.mode, pn.concerns, pn.agreed_actions, pn.follow_up_on, pn.follow_up_done,
        (pn.follow_up_done = 0 AND pn.follow_up_on IS NOT NULL AND pn.follow_up_on < ?) AS overdue, u.full_name AS recorded_by, pn.recorded_by = ? AS mine
        FROM ptm_notes pn JOIN students st ON st.id = pn.student_id LEFT JOIN sections sec ON sec.id = pn.section_id
        LEFT JOIN classes c ON c.id = sec.class_id LEFT JOIN users u ON u.id = pn.recorded_by
        WHERE (? IS NULL OR pn.student_id = ?) AND (? IS NULL OR pn.section_id = ?)
          AND (? = 0 OR (pn.follow_up_done = 0 AND pn.follow_up_on IS NOT NULL)) AND ${pred.sql}
        ORDER BY pn.met_on DESC, pn.created_at DESC LIMIT 300`)
      .bind(todayIST(), c.id.userId, sid, sid, sec, sec, pending, ...pred.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, follow_up_done: bool(v.follow_up_done), overdue: bool(v.overdue), mine: bool(v.mine) })) })
  })

  r.post('/teaching/ptm-notes', P, async (c) => {
    requireAny(c, 'welfare.discipline.write', 'comms.announcements.write')
    const req = await readJSON<{ student_id?: string; term_id?: string; met_on?: string; attendance?: string; attended_by?: string; mode?: string; concerns?: string; agreed_actions?: string; follow_up_on?: string; follow_up_done?: boolean; private?: boolean }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    const attendance = req.attendance || 'guardian', mode = req.mode || 'in_person'
    if (attendance !== 'none' && !(req.concerns ?? '').trim() && !(req.agreed_actions ?? '').trim()) throw badRequest('record what the parent raised or what was agreed')
    const s = await resolveScope(c)
    if (!(await reachesTaughtStudent(c, s, req.student_id))) throw notFound()
    const metOn = nul(req.met_on) ?? todayIST()
    const vis = int(!(req.private === true)), done = int(req.follow_up_done === true), ts = now()
    const vals = [nul(req.term_id), attendance, nul(req.attended_by), mode, nul(req.concerns), nul(req.agreed_actions), nul(req.follow_up_on), done, vis]
    const existing = await c.db.prepare(`SELECT id FROM ptm_notes WHERE student_id = ? AND met_on = ? AND COALESCE(recorded_by,'') = ? LIMIT 1`).bind(req.student_id, metOn, c.id.userId).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE ptm_notes SET term_id = ?, attendance = ?, attended_by = ?, mode = ?, concerns = ?, agreed_actions = ?, follow_up_on = ?, follow_up_done = ?, visible_to_family = ?, updated_at = ? WHERE id = ?`)
        .bind(...vals, ts, existing.id).run()
      return created({ id: existing.id })
    }
    const id = uuid()
    await c.db.prepare(`INSERT INTO ptm_notes (id, institution_id, student_id, section_id, met_on, term_id, attendance, attended_by, mode, concerns, agreed_actions, follow_up_on, follow_up_done, visible_to_family, recorded_by, created_at, updated_at)
        SELECT ?, ?, ?, (SELECT e.section_id FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`)
      .bind(id, institutionId(c), req.student_id, req.student_id, metOn, ...vals, c.id.userId, ts, ts).run()
    return created({ id })
  })

  r.get('/teaching/broadcasts', P, async (c) => {
    const s = await resolveScope(c)
    const secs = s.sectionIds
    const rows = await c.db.prepare(`SELECT a.id, a.title, a.body, a.kind, a.requires_ack, substr(a.publish_at,1,10) AS published_at,
        (SELECT count(*) FROM announcement_sections x WHERE x.announcement_id = a.id) AS sections,
        (SELECT count(*) FROM announcement_students x WHERE x.announcement_id = a.id) AS students,
        (SELECT count(*) FROM announcement_acks x WHERE x.announcement_id = a.id) AS acknowledgements, a.created_by = ? AS mine
        FROM announcements a WHERE a.created_by = ? OR EXISTS (SELECT 1 FROM announcement_sections x WHERE x.announcement_id = a.id AND x.section_id IN (${marks(secs)}))
        ORDER BY a.publish_at DESC LIMIT 100`).bind(c.id.userId, c.id.userId, js(secs)).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, requires_ack: bool(v.requires_ack), mine: bool(v.mine) })) })
  })

  r.post('/teaching/broadcasts', P, async (c) => {
    requirePerm(c, 'comms.announcements.write')
    const req = await readJSON<{ title?: string; body?: string; section_ids?: string[]; student_ids?: string[]; requires_ack?: boolean; send_email?: boolean; send_sms?: boolean; send_whatsapp?: boolean; client_ref?: string }>(c.req)
    const title = (req.title ?? '').trim(), body = (req.body ?? '').trim()
    if (!title || !body) throw badRequest('title and body are required')
    const sectionIds = req.section_ids ?? [], studentIds = req.student_ids ?? []
    if (!sectionIds.length && !studentIds.length) throw badRequest('name at least one class or child to send this to')
    const s = await resolveScope(c)
    for (const sid of sectionIds) {
      if (!isUUID(sid)) throw badRequest('section_ids must be uuids')
      if (!reachesSection(s, sid)) throw forbidden('you can only write to a class you teach')
    }
    for (const sid of studentIds) if (!isUUID(sid)) throw badRequest('student_ids must be uuids')
    for (const sid of studentIds) if (!(await reachesTaughtStudent(c, s, sid))) throw notFound()

    const inst = institutionId(c)
    const ref = (req.client_ref ?? '').trim()
    const target = `st.status = 'active' AND (e.section_id IN (${marks(sectionIds)}) OR st.id IN (${marks(studentIds)}))`
    const countStmt = c.db.prepare(`SELECT count(DISTINCT g.user_id) AS n FROM students st JOIN student_guardians sg ON sg.student_id = st.id
        JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
        WHERE ${target}`).bind(js(sectionIds), js(studentIds))
    let annId: string | null = null, duplicate = false
    if (ref) {
      const ex = await c.db.prepare(`SELECT id FROM announcements WHERE institution_id = ? AND client_ref = ?`).bind(inst, ref).first<{ id: string }>()
      if (ex) { annId = ex.id; duplicate = true }
    }
    if (!annId) {
      annId = uuid()
      const stmts = [c.db.prepare(`INSERT INTO announcements (id, institution_id, title, body, kind, audience_role, requires_ack, publish_at, created_by, client_ref, created_at)
          VALUES (?, ?, ?, ?, 'notice', 'parents', ?, ?, ?, ?, ?)`).bind(annId, inst, title, body, int(req.requires_ack === true), now(), c.id.userId, ref || null, now())]
      for (const sid of sectionIds) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO announcement_sections (announcement_id, section_id, institution_id) VALUES (?, ?, ?)`).bind(annId, sid, inst))
      for (const sid of studentIds) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO announcement_students (announcement_id, student_id, institution_id) VALUES (?, ?, ?)`).bind(annId, sid, inst))
      await c.db.batch(stmts)
    }
    const recipients = (await countStmt.first<{ n: number }>())?.n ?? 0
    if (duplicate) return ok({ id: annId, recipients, sections: sectionIds.length, students: studentIds.length, messages_queued: 0, duplicate: true })
    const channels = [req.send_email && 'email', req.send_sms && 'sms', req.send_whatsapp && 'whatsapp'].filter(Boolean)
    const out: Record<string, unknown> = { id: annId, recipients, sections: sectionIds.length, students: studentIds.length, messages_queued: 0 }
    if (channels.length) {
      // One message:send job per household per channel (announcement.published), as Go's fan-out.
      try {
        const to = (await c.db.prepare(`SELECT DISTINCT g.user_id FROM students st JOIN student_guardians sg ON sg.student_id = st.id
            JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
            WHERE ${target}`).bind(js(sectionIds), js(studentIds)).all<{ user_id: string }>()).results
        const jobs = to.flatMap((u) => channels.map((ch) => ({ type: 'message:send', institution_id: inst,
          payload: { institution_id: inst, channel: ch as string, template_key: 'announcement.published', to_user_id: u.user_id, job_id: uuid(), vars: { title, body } } })))
        try { await enqueueMany(c.env, jobs); out.messages_queued = jobs.length } catch { out.messages_failed = jobs.length }
      } catch {
        out.send_error = 'the notice was published but could not be handed to the sender'
      }
    }
    return created(out)
  })

  r.get('/teaching/communication', P, async (c) => {
    const s = await resolveScope(c)
    const secs = s.sectionIds
    const mine = `SELECT DISTINCT e.student_id FROM enrollments e WHERE e.status = 'active' AND e.section_id IN (${marks(secs)})`
    const row = await c.db.prepare(`WITH mine AS (${mine})
      SELECT (SELECT count(*) FROM mine) AS students,
             (SELECT count(*) FROM student_remarks sr WHERE sr.student_id IN (SELECT student_id FROM mine) AND sr.kind <> 'anecdotal') AS remarks,
             (SELECT count(*) FROM student_remarks sr WHERE sr.student_id IN (SELECT student_id FROM mine) AND sr.kind = 'anecdotal') AS anecdotal_records,
             (SELECT count(*) FROM ptm_notes pn WHERE pn.student_id IN (SELECT student_id FROM mine)) AS ptm_notes,
             (SELECT count(*) FROM ptm_notes pn WHERE pn.student_id IN (SELECT student_id FROM mine) AND pn.follow_up_done = 0 AND pn.follow_up_on IS NOT NULL AND pn.follow_up_on < ?) AS actions_overdue,
             (SELECT count(*) FROM announcements a WHERE a.created_by = ?) AS broadcasts,
             (SELECT count(*) FROM announcements a WHERE a.created_by = ? AND a.requires_ack = 1 AND NOT EXISTS (SELECT 1 FROM announcement_acks ak WHERE ak.announcement_id = a.id)) AS awaiting_acknowledgement,
             (SELECT count(*) FROM terms) AS terms`).bind(js(secs), todayIST(), c.id.userId, c.id.userId).first<Record<string, number>>()
    return ok({ sections: secs.length, ...row })
  })
}

export function registerChildRemarks(r: Router) {
  r.get('/portal/remarks', 'self.profile.read', async (c) => {
    const s = await resolveScope(c)
    if (!s.studentIds.length) throw forbidden("a parent's own remarks")
    const sid = nul(c.url.searchParams.get('student_id'))
    const rows = await c.db.prepare(`SELECT sr.id, sr.student_id, ${shortName('st')} AS child_name, sr.observed_on, sr.kind, sr.body,
        sub.name AS subject, c.name AS class_name, sec.name AS section_name, u.full_name AS teacher
        FROM student_remarks sr JOIN students st ON st.id = sr.student_id LEFT JOIN sections sec ON sec.id = sr.section_id
        LEFT JOIN classes c ON c.id = sec.class_id LEFT JOIN class_subjects cs ON cs.id = sr.class_subject_id
        LEFT JOIN subjects sub ON sub.id = cs.subject_id LEFT JOIN users u ON u.id = sr.recorded_by
        WHERE sr.student_id IN (${marks(s.studentIds)}) AND (? IS NULL OR sr.student_id = ?) AND sr.visible_to_family = 1
        ORDER BY sr.observed_on DESC, sr.created_at DESC LIMIT 200`).bind(js(s.studentIds), sid, sid).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })
}
