import type { Router } from '../../router'
import { enqueueMessageSends } from '../../services/messaging'
import { json } from '../../env'
import { HttpError, badRequest, created, forbidden, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { can } from '../../identity'
import { addDays, fullName, isUUIDish, notImplemented, nz, str, todayIST } from '../admissions/util'

/* Port of the /attendance-workflow group (mod_academics.go, module 3) and
   the /operations dashboard (role_backoffice.go). */

const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** scope.CanMarkSection: the class teacher of the section, or anyone who may mark any register. */
async function canMarkSection(c: { db: D1Database; id: import('../../identity').Identity }, sectionID: string): Promise<boolean> {
  if (c.id.platformAdmin || can(c.id, 'academics.attendance.write.any')) return true
  const row = await c.db.prepare(`SELECT 1 FROM sections WHERE id = ? AND class_teacher_id = ?`).bind(sectionID, c.id.userId).first()
  return !!row
}

/** requireOpenPeriod (period_close.go), kind = month: a month closed by hand, or inside a closed year. */
async function requireOpenMonth(db: D1Database, inst: string, onDate: string): Promise<void> {
  const row = await db.prepare(`
    SELECT EXISTS (SELECT 1 FROM period_closes WHERE institution_id = ? AND kind = 'month' AND period_key = ? AND reopened_at IS NULL) AS month_closed,
           (SELECT name FROM academic_years WHERE institution_id = ? AND closed_at IS NOT NULL AND ? BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1) AS year_name`)
    .bind(inst, onDate.slice(0, 7), inst, onDate).first<{ month_closed: number; year_name: string | null }>()
  if (row?.month_closed) {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    throw new HttpError(409, `${MONTHS[Number(onDate.slice(5, 7)) - 1]} ${onDate.slice(0, 4)} is closed; ask the principal to reopen it`, { code: 'period_closed' })
  }
  if (row?.year_name) throw new HttpError(409, `The year ${row.year_name} is closed; ask the principal to reopen it`, { code: 'period_closed' })
}

export function registerAttendanceWorkflow(r: Router) {
  r.post('/attendance-workflow/corrections', 'academics.attendance.write', async (c) => {
    const req = await readJSON(c.req)
    const attID = str(req.attendance_id)
    if (!isUUIDish(attID)) throw badRequest('attendance_id must be a uuid')
    if (str(req.reason).trim() === '') throw badRequest('reason is required')
    const att = await c.db.prepare(`SELECT status, section_id FROM student_attendance WHERE id = ?`).bind(attID).first<{ status: string; section_id: string }>()
    if (!att) throw notFound()
    if (!(await canMarkSection(c, att.section_id))) throw forbidden('attendance correction for this section')
    const id = uuid()
    await c.db.prepare(`INSERT INTO attendance_corrections (id, institution_id, attendance_id, requested_by, from_status, to_status, reason, status, created_at) VALUES (?,?,?,?,?,?,?,'pending',?)`)
      .bind(id, c.id.institution!.id, attID, c.id.userId, att.status, str(req.to_status), str(req.reason), now()).run()
    return created({ id, status: 'pending' })
  })

  r.get('/attendance-workflow/corrections', 'academics.attendance.read', async (c) => {
    const status = nz(c.url.searchParams.get('status'))
    const rows = await c.db.prepare(`
      SELECT ac.id, ${fullName('st.first_name', 'st.last_name')} AS student_name, sa.on_date, ac.from_status, ac.to_status, ac.reason, u.full_name AS requested_by, ac.status
        FROM attendance_corrections ac JOIN student_attendance sa ON sa.id = ac.attendance_id JOIN students st ON st.id = sa.student_id LEFT JOIN users u ON u.id = ac.requested_by
       WHERE (? IS NULL OR ac.status = ?) ORDER BY ac.created_at DESC LIMIT 200`).bind(status, status).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/attendance-workflow/corrections/{id}/decide', 'academics.attendance.write.any', async (c) => {
    const cid = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const decision = str(req.decision)
    if (decision !== 'approved' && decision !== 'rejected') throw badRequest('decision must be approved or rejected')
    const pending = await c.db.prepare(`SELECT ac.attendance_id, ac.to_status, ac.requested_by, sa.on_date, sa.institution_id, ${fullName('st.first_name', 'st.last_name')} AS child
        FROM attendance_corrections ac JOIN student_attendance sa ON sa.id = ac.attendance_id JOIN students st ON st.id = sa.student_id WHERE ac.id = ? AND ac.status = 'pending'`).bind(cid)
      .first<{ attendance_id: string; to_status: string; requested_by: string | null; on_date: string; institution_id: string; child: string }>()
    if (!pending) throw new HttpError(404, 'no pending correction with that id', { code: 'not_found' })
    if (decision === 'approved') await requireOpenMonth(c.db, pending.institution_id, pending.on_date)
    const t = now()
    const stmts = [c.db.prepare(`UPDATE attendance_corrections SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).bind(decision, c.id.userId, t, cid)]
    if (decision === 'approved') {
      stmts.push(c.db.prepare(`UPDATE student_attendance SET corrected_from = status, status = ?, corrected_by = ?, corrected_at = ? WHERE id = ?`).bind(pending.to_status, c.id.userId, t, pending.attendance_id))
    }
    // And tell whoever asked, unless they decided their own request.
    if (pending.requested_by && pending.requested_by !== c.id.userId) {
      const verb = decision === 'approved' ? 'approved' : 'not approved'
      const body = decision === 'approved' ? `The register for ${pending.on_date} has been amended.` : `The mark for ${pending.on_date} stands as it was. Raise it again if it is still wrong.`
      const dup = await c.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'correction_decided' AND source_id = ? AND student_id IS NULL`).bind(pending.requested_by, cid).first()
      if (!dup) {
        stmts.push(c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at) VALUES (?,?,?,NULL,'correction_decided',?,?,'/go/attendance_correction','attendance_correction',?,?)`)
          .bind(uuid(), c.id.institution!.id, pending.requested_by, `Your correction for ${pending.child} was ${verb}`, body, cid, t))
      }
    }
    const res = await c.db.batch(stmts)
    if ((res[0]?.meta.changes ?? 0) === 0) throw new HttpError(404, 'no pending correction with that id', { code: 'not_found' })
    return ok({ id: cid, status: decision })
  })

  r.post('/attendance-workflow/absence-alerts', 'comms.messages.send', async (c) => {
    // sendAbsenceAlerts: one attendance.absent SMS job per absent student's primary guardian.
    const onDate = c.url.searchParams.get('on_date') ?? ''
    const day = onDate !== '' ? onDate : todayIST()
    const targets = (await c.db.prepare(`SELECT g.user_id, trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) AS student
        FROM student_attendance sa JOIN students st ON st.id = sa.student_id
        JOIN student_guardians sg ON sg.student_id = st.id AND sg.is_primary JOIN guardians g ON g.id = sg.guardian_id
       WHERE substr(sa.on_date,1,10) = ? AND sa.status = 'absent' AND g.user_id IS NOT NULL`).bind(day).all<{ user_id: string; student: string }>()).results
    await enqueueMessageSends(c.env, c.id.institution!.id, targets.map((t) => ({ channel: 'sms', template_key: 'attendance.absent', to_user_id: t.user_id,
      vars: { student: t.student, date: onDate } })))
    return json({ absent_students: targets.length, messages_queued: targets.length }, 202)
  })

  /* /operations/dashboard carries RequireAnyPermission over the four operations reads; the router
     has no any-of form, so it is registered on 'auth' and the handler checks the four itself. */
  r.get('/operations/dashboard', 'auth', async (c) => {
    if (!['operations.library.read', 'operations.transport.read', 'operations.hostel.read', 'operations.inventory.read'].some((p) => can(c.id, p))) throw forbidden()
    const today = todayIST()
    const k = await c.db.prepare(`
      SELECT (SELECT count(*) FROM library_titles) AS library_titles,
             (SELECT count(*) FROM library_loans WHERE returned_on IS NULL) AS loans_out,
             (SELECT count(*) FROM library_loans WHERE returned_on IS NULL AND due_on < ?) AS loans_overdue,
             (SELECT count(*) FROM vehicles WHERE status = 'active') AS vehicles,
             (SELECT count(*) FROM routes WHERE is_active = 1) AS routes,
             (SELECT count(*) FROM vehicles WHERE status='active' AND MIN(COALESCE(insurance_expiry,'9999-12-31'), COALESCE(fitness_expiry,'9999-12-31'), COALESCE(permit_expiry,'9999-12-31'), COALESCE(puc_expiry,'9999-12-31')) <= ?) AS vehicle_docs_expiring,
             (SELECT count(*) FROM transport_allocations) AS hostel_students`).bind(today, addDays(today, 30)).first()
    return ok(k)
  })
}
