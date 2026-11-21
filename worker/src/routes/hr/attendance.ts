import type { Router } from '../../router'
import { Messenger, enqueueMessageSends, scopeOf } from '../../services/messaging'
import { testGuardians } from '../../services/test_send'
import { CONNECT_FOR, connectReady } from '../../services/channel_pick'
import { pickChannels, wantsInApp, ALERT_GUARDIANS } from '../../services/channel_pick'
import { channelStatus, liveMap, phoneOf } from '../../services/delivery'
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
  const row = await c.db.prepare(`SELECT 1 FROM section_class_teachers WHERE section_id = ? AND user_id = ?`).bind(sectionID, c.id.userId).first()
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
    const att = await c.db.prepare(`SELECT status, section_id, on_date FROM student_attendance WHERE id = ?`).bind(attID).first<{ status: string; section_id: string; on_date: string }>()
    if (!att) throw notFound()
    if (!(await canMarkSection(c, att.section_id))) throw forbidden('attendance correction for this section')
    const id = uuid()
    const t = now()
    const stmts = [c.db.prepare(`INSERT INTO attendance_corrections (id, institution_id, attendance_id, requested_by, from_status, to_status, reason, status, created_at) VALUES (?,?,?,?,?,?,?,'pending',?)`)
      .bind(id, c.id.institution!.id, attID, c.id.userId, att.status, str(req.to_status), str(req.reason), t)]
    // Tell whoever can decide it (academics.attendance.write.any), not the asker.
    const deciders = await c.db.prepare(`
      SELECT DISTINCT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE u.institution_id = ? AND u.status = 'active' AND u.id <> ? AND rp.permission_key = 'academics.attendance.write.any'`)
      .bind(c.id.institution!.id, c.id.userId).all<{ id: string }>()
    for (const d of deciders.results) {
      stmts.push(c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
          VALUES (?,?,?,NULL,'correction_request',?,?,'/go/approvals/approvals','attendance_correction',?,?)`)
        .bind(uuid(), c.id.institution!.id, d.id, `${c.id.fullName} asks to correct attendance on ${att.on_date}`,
          `${att.status} to ${str(req.to_status)}. ${str(req.reason)}. Approve or reject it from Approvals.`, id, t))
    }
    await c.db.batch(stmts)
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
    // DISTINCT: a period-wise register has a row per period, and a child absent all day is one alert, not six.
    const targets = (await c.db.prepare(`SELECT DISTINCT g.user_id, st.id AS student_id, trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) AS student
        FROM student_attendance sa JOIN students st ON st.id = sa.student_id
        JOIN student_guardians sg ON sg.student_id = st.id AND sg.is_primary JOIN guardians g ON g.id = sg.guardian_id
       WHERE substr(sa.on_date,1,10) = ? AND sa.status = 'absent' AND g.user_id IS NOT NULL`).bind(day).all<{ user_id: string; student_id: string; student: string }>()).results
    // Keyed per child per day: pressing the button twice, or after a later period, sends nothing new.
    await enqueueMessageSends(c.env, c.id.institution!.id, targets.map((t) => ({ channel: 'sms', template_key: 'attendance.absent', to_user_id: t.user_id,
      vars: { student: t.student, date: day }, student_id: t.student_id, source_kind: 'absence_alert', dedupe_key: `absence:${day}:${t.student_id}` })))
    return json({ absent_students: targets.length, messages_queued: targets.length }, 202)
  })

  /* PRESENT & ABSENT: tell the parents from the day's list (owner, 2026-11-20).

     After the register is taken, the office ticks children on the Absent or Present
     tab and the channels to use (In app, Yajur Connect, SMS) and sends. Keyed per
     child per day on the same key the absence button and the automatic alert use,
     so a child's absence is told once, however many people press Send. */
  const PARENT_MSG = ['comms.messages.send', 'academics.attendance.write', 'academics.attendance.write.any']
  const toldKey = (kind: string, day: string, sid: string) => `${kind === 'present' ? 'present' : 'absence'}:${day}:${sid}`
  r.get('/attendance-workflow/parent-messages', 'auth', async (c) => {
    if (!PARENT_MSG.some((p) => can(c.id, p))) throw forbidden()
    const day = c.url.searchParams.get('on_date') || todayIST()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('on_date must be a date')
    const rows = (await c.db.prepare(`
      SELECT DISTINCT CASE WHEN idempotency_key LIKE 'dk:present:%' THEN 'present' ELSE 'absent' END AS kind,
             substr(idempotency_key, length('dk:absence:') + 12, 36) AS sid_a, substr(idempotency_key, length('dk:present:') + 12, 36) AS sid_p
        FROM message_log WHERE idempotency_key LIKE 'dk:absence:' || ?1 || ':%' OR idempotency_key LIKE 'dk:present:' || ?1 || ':%'
      UNION
      SELECT DISTINCT 'absent', source_id, source_id FROM message_log
       WHERE source_kind = 'absence_alert' AND occurrence_key LIKE ?1 || ':%'`).bind(day)
      .all<{ kind: string; sid_a: string; sid_p: string }>()).results
    const absent = new Set<string>(), present = new Set<string>()
    for (const r of rows) (r.kind === 'present' ? present.add(r.sid_p) : absent.add(r.sid_a))
    return ok({ on_date: day, told_absent: [...absent].filter(isUUIDish), told_present: [...present].filter(isUUIDish) })
  })

  r.post('/attendance-workflow/parent-messages', 'auth', async (c) => {
    if (!PARENT_MSG.some((p) => can(c.id, p))) throw forbidden()
    const req = await readJSON<{ on_date?: string; kind?: string; student_ids?: string[]; channels?: string[]; test?: boolean }>(c.req)
    const day = (req.on_date ?? '').trim() || todayIST()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('on_date must be a date')
    const kind = req.kind === 'present' ? 'present' : 'absent'
    const ids = (req.student_ids ?? []).map(String).filter(isUUIDish).slice(0, 2000)
    if (!ids.length && !req.test) throw badRequest('tick at least one child')
    const inst = c.id.institution!.id
    let paid = pickChannels(req.channels, liveMap(await channelStatus(c.env, c.db, inst)))
    // Yajur Connect only through its approved template (absence, or the general circular for "present").
    const connectCode = CONNECT_FOR[kind === 'absent' ? 'absence' : 'present']
    const connectMissing = paid.includes('whatsapp') && !(await connectReady(c.db, connectCode))
    if (connectMissing) paid = paid.filter((x) => x !== 'whatsapp')
    const inApp = wantsInApp(req.channels)
    if (!inApp && !paid.length) throw badRequest(connectMissing ? 'there is no Yajur Connect template for this message: set one in Message Channels → Wording' : 'choose at least one way to send')
    const pick = (ch: string, template: string, vars: Record<string, unknown>, parent: string | null, cls: string) =>
      ch === 'whatsapp'
        ? { code: connectCode, vars: kind === 'absent'
            ? { parent_name: parent || 'Parent', student_name: vars.student, class: cls || '-', date: vars.date }
            : { parent_name: parent || 'Parent', message: String(vars.text) } }
        : { code: template, vars }
    const classOf = async (sid: string) => (await c.db.prepare(`SELECT cl.name || COALESCE('-' || se.name, '') AS n FROM enrollments en JOIN classes cl ON cl.id = en.class_id
        LEFT JOIN sections se ON se.id = en.section_id WHERE en.student_id = ? AND en.status = 'active' ORDER BY en.enrolled_on DESC LIMIT 1`).bind(sid).first<{ n: string }>())?.n ?? ''
    /* A test send goes to the school's test parents only, about their own
       linked child, whatever was ticked; it is never counted as "told". */
    const tests = req.test ? await testGuardians(c.db) : []
    if (req.test && !tests.length) throw badRequest('no test parent: add their number to the allowlist in Message Channels')
    if (req.test) {
      const testKids = [...new Set(tests.map((t) => t.student_id))]
      const names = (await c.db.prepare(`SELECT id, trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM students WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(testKids)).all<{ id: string; name: string }>()).results
      const jobs: Parameters<typeof enqueueMessageSends>[2] = []
      const run = uuid()
      for (const k of names) {
        const template = kind === 'absent' ? 'attendance.absent' : 'messaging.direct'
        const vars = kind === 'absent' ? { student: k.name, date: day } : { text: `${k.name} was marked present on ${day}.`, subject: 'Attendance' }
        const cls = await classOf(k.id)
        for (const t of tests.filter((x) => x.student_id === k.id && x.uid)) {
          for (const ch of [...(inApp ? ['in_app'] : []), ...paid]) {
            const m = pick(ch, template, vars, t.name, cls)
            jobs.push({ channel: ch, template_key: m.code, to_user_id: t.uid!, vars: m.vars, student_id: k.id, source_kind: 'absence_test', source_id: k.id, dedupe_key: `test:${run}:${k.id}`, exact: true })
          }
        }
      }
      if (jobs.length) await enqueueMessageSends(c.env, inst, jobs)
      return json({ connect_missing: connectMissing || undefined, test: true, children: names.length, already_told: 0, skipped: 0, messages_queued: jobs.length, channels: [...(inApp ? ['in_app'] : []), ...paid] }, 202)
    }
    // Only children really marked so that day; a period-wise register has a row per period.
    const kids = (await c.db.prepare(`SELECT DISTINCT st.id, trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) AS name
        FROM student_attendance sa JOIN students st ON st.id = sa.student_id
       WHERE substr(sa.on_date,1,10) = ? AND sa.status = ? AND st.id IN (SELECT value FROM json_each(?))`)
      .bind(day, kind, JSON.stringify(ids)).all<{ id: string; name: string }>()).results
    const jobs: Parameters<typeof enqueueMessageSends>[2] = []
    const ms = new Messenger(scopeOf(c))
    let direct = 0
    let already = 0
    for (const k of kids) {
      const key = toldKey(kind, day, k.id)
      // Told once: a family already told about this child today (by anyone, any channel) is not told again.
      const told = await c.db.prepare(`SELECT 1 FROM message_log WHERE substr(idempotency_key, 1, length(?1)) = ?1 OR (?2 = 'absent' AND source_kind = 'absence_alert' AND source_id = ?3 AND occurrence_key LIKE ?4) LIMIT 1`)
        .bind(`dk:${key}:`, kind, k.id, `${day}:%`).first()
      if (told) { already++; continue }
      const template = kind === 'absent' ? 'attendance.absent' : 'messaging.direct'
      const vars = kind === 'absent' ? { student: k.name, date: day } : { text: `${k.name} was marked present on ${day}.`, subject: 'Attendance' }
      const people = (await c.db.prepare(`SELECT g.user_id AS uid, g.phone, g.full_name AS name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
          WHERE sg.student_id = ? AND NOT sg.portal_blocked AND ${ALERT_GUARDIANS}`).bind(k.id).all<{ uid: string | null; phone: string | null; name: string | null }>()).results
      const cls = paid.includes('whatsapp') ? await classOf(k.id) : ''
      const phones = new Set<string>()
      for (const p of people) {
        if (p.uid) {
          for (const ch of [...(inApp ? ['in_app'] : []), ...paid]) {
            const m = pick(ch, template, vars, p.name, cls)
            jobs.push({ channel: ch, template_key: m.code, to_user_id: p.uid, vars: m.vars, student_id: k.id, source_kind: 'absence_alert', source_id: k.id, dedupe_key: key, exact: true })
          }
          const ph = phoneOf(p.phone); if (ph) phones.add(ph)
        } else {
          const ph = phoneOf(p.phone)
          if (!ph || phones.has(ph)) continue
          phones.add(ph)
          for (const ch of paid) {
            if (ch === 'email') continue
            try {
              const m = pick(ch, template, vars, p.name, cls)
              const r2 = await ms.queue({ channel: ch, template_code: m.code, vars: m.vars, recipient: ph, student_id: k.id, source_kind: 'absence_alert', source_id: k.id,
                occurrence_key: `${day}:${ph}`, idempotency_key: `dk:${key}:${ph}:${ch}`, exact_channel: true })
              if (!r2.duplicate) direct++
            } catch { /* a channel this contact cannot take */ }
          }
        }
      }
    }
    if (jobs.length) await enqueueMessageSends(c.env, inst, jobs)
    if (direct) await ms.kick()
    return json({ connect_missing: connectMissing || undefined, children: kids.length - already, already_told: already, skipped: ids.length - kids.length, messages_queued: jobs.length + direct, channels: [...(inApp ? ['in_app'] : []), ...paid] }, 202)
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
