import type { Router, Ctx } from '../router'
import { Messenger, enqueueMessageSends, scopeOf } from '../services/messaging'
import { HttpError, badRequest, bool, isUUID, notFound, ok, created, readJSON, uuid, uuidParam, now } from '../http'
import { school } from './school'
import { requireFresh } from './fees/common'
import { MONTHS, coded, daysInMonth, dateOf, inList, items, js, minuteOf, nameOf, nowIST, num, numOr0, pad2, requireOpenMonth,
  resolveScope, str, todayIST, uuidsOf } from './exams/common'

/* Port of the /communication, /timetable-admin, /compliance and /payroll
   route groups (internal/api/api.go lines 1235-1301) and their handlers in
   mod_ops.go, circular_delivery.go, payroll_release.go, salary_setup.go,
   payroll_statutory.go and payroll_tax.go. The staff_lop_register() SQL
   function (migrations/00244) is re-implemented in lopRegister() below.

   Shared helpers (scope, notifications, periods) live in ./exams/common.ts. */

const ANNOUNCEMENTS_WRITE = 'comms.announcements.write'
const TIMETABLE_WRITE = 'academics.timetable.write'
const REPORTS_READ = 'admin.reports.read'
const STUDENTS_WRITE = 'students.write'
const PAYROLL_READ = 'hr.payroll.read'
const PAYROLL_WRITE = 'hr.payroll.write'

const EMP_NAME = nameOf('e', false)

export function registerPayroll(r: Router): void {
  registerCommunication(r)
  r.post('/timetable-admin/substitutions', TIMETABLE_WRITE, createSubstitution)
  registerCompliance(r)
  registerPayrollGroup(r)
}

// ============================================================ /communication

/* Who a circular is addressed to; the same query decides the count, the
   fan-out and the delivery report. ?1 = 1 when no sections are named, ?2..
   the section ids, then the audience role. Built per call because the
   section list is variable-length. */
function circularRecipients(sections: string[]): { sql: string; args: unknown[] } {
  const all = sections.length === 0 ? 1 : 0
  const list = inList(sections)
  const sql = `
    SELECT g.user_id AS user_id
      FROM students st
      JOIN student_guardians sg ON sg.student_id = st.id
      JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
      LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
     WHERE st.status = 'active' AND ?1 IN ('all','parents','everyone') AND (?2 OR e.section_id IN ${list})
    UNION
    SELECT st.user_id
      FROM students st
      LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
     WHERE st.status = 'active' AND st.user_id IS NOT NULL AND ?1 IN ('all','students','everyone') AND (?2 OR e.section_id IN ${list})
    UNION
    SELECT u.id FROM employees emp JOIN users u ON u.id = emp.user_id
     WHERE emp.status = 'active' AND ?1 IN ('staff','everyone')`
  return { sql, args: [all, js(sections), js(sections)] }
}

function circularContactOnly(sections: string[]): { sql: string; args: unknown[] } {
  const all = sections.length === 0 ? 1 : 0
  const sql = `
    SELECT COALESCE(g.phone,'') AS phone, COALESCE(g.email,'') AS email
      FROM students st
      JOIN student_guardians sg ON sg.student_id = st.id
      JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NULL AND (NULLIF(g.phone,'') IS NOT NULL OR g.email IS NOT NULL)
      LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
     WHERE st.status = 'active' AND ?1 IN ('all','parents','everyone') AND (?2 OR e.section_id IN ${inList(sections)})
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.institution_id = g.institution_id
                         AND ((NULLIF(g.phone,'') IS NOT NULL AND u.phone = g.phone) OR (g.email IS NOT NULL AND u.email = g.email)))
     GROUP BY COALESCE(NULLIF(g.phone,''), g.email)`
  return { sql, args: [all, js(sections)] }
}

function registerCommunication(r: Router) {
  r.get('/communication/circulars', 'auth', async (c) => {
    const res = await resolveScope(c)
    const args: unknown[] = [c.id.userId]
    let where = 'TRUE'
    const family = !res.platformAdmin && !res.allStudents && !res.allAttendance && !res.anySection &&
      res.sectionIds.length === 0 && res.departmentIds.length === 0 && res.studentIds.length > 0
    if (family) {
      const kids = inList(res.studentIds)
      where = `a.publish_at <= ?2 AND (a.expires_at IS NULL OR a.expires_at > ?2)
        AND (a.audience_role = 'all'
             OR (a.audience_role = 'students' AND EXISTS (SELECT 1 FROM students me WHERE me.user_id = ?1))
             OR (a.audience_role = 'parents' AND EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = ?1)))
        AND ((NOT EXISTS (SELECT 1 FROM announcement_sections x WHERE x.announcement_id = a.id)
              AND NOT EXISTS (SELECT 1 FROM announcement_students x WHERE x.announcement_id = a.id))
             OR EXISTS (SELECT 1 FROM announcement_sections x JOIN enrollments e ON e.section_id = x.section_id
                         WHERE x.announcement_id = a.id AND e.student_id IN ${kids} AND e.status = 'active')
             OR EXISTS (SELECT 1 FROM announcement_students x WHERE x.announcement_id = a.id AND x.student_id IN ${kids}))`
      args.push(now(), js(res.studentIds), js(res.studentIds))
    }
    const rows = await c.db.prepare(`
      SELECT a.id, a.title, a.kind, a.audience_role, a.requires_ack, ${dateOf('a.publish_at')} AS published_at,
             ${minuteOf('a.publish_at')} AS published_at_full, COALESCE(u.full_name, '') AS published_by,
             (SELECT COUNT(*) FROM announcement_acks ak WHERE ak.announcement_id = a.id) AS acknowledgements,
             (SELECT COUNT(*) FROM announcement_sections s2 WHERE s2.announcement_id = a.id) AS sections,
             EXISTS (SELECT 1 FROM announcement_acks ak WHERE ak.announcement_id = a.id AND ak.user_id = ?1) AS mine,
             a.body
        FROM announcements a LEFT JOIN users u ON u.id = a.created_by
       WHERE ${where}
       ORDER BY a.publish_at DESC LIMIT 200`).bind(...args).all()
    return ok(items(rows.results.map((v) => ({
      id: v.id, title: v.title, kind: v.kind, audience_role: v.audience_role, requires_ack: bool(v.requires_ack),
      published_at: v.published_at, published_at_full: v.published_at_full, published_by: v.published_by || undefined,
      acknowledgements: numOr0(v.acknowledgements), sections: numOr0(v.sections), acknowledged_by_me: bool(v.mine),
      body: v.body || undefined,
    }))))
  })

  r.get('/communication/circulars/{id}/delivery', 'auth', async (c) => {
    const annId = uuidParam(c.params.id)
    const ann = await c.db.prepare(`SELECT a.title, a.audience_role, SUBSTR(a.publish_at,1,10) || ' ' || SUBSTR(a.publish_at,12,5) AS published_at
        FROM announcements a WHERE a.id = ?`).bind(annId).first<{ title: string; audience_role: string; published_at: string }>()
    if (!ann) throw notFound('resource not found')
    const secs = await c.db.prepare(`SELECT section_id FROM announcement_sections WHERE announcement_id = ?`).bind(annId).all<{ section_id: string }>()
    const sections = secs.results.map((s) => s.section_id)
    const rc = circularRecipients(sections)
    const people = await c.db.prepare(`
      WITH recipients AS (${rc.sql})
      SELECT COALESCE(u.full_name, u.email, 'unnamed') AS name,
             CASE WHEN g.id IS NOT NULL THEN 'guardian' WHEN st.id IS NOT NULL THEN 'student' ELSE 'staff' END AS role,
             COALESCE((SELECT TRIM(s2.first_name || ' ' || COALESCE(s2.last_name,'')) FROM student_guardians sg2 JOIN students s2 ON s2.id = sg2.student_id
                        WHERE sg2.guardian_id = g.id ORDER BY s2.first_name LIMIT 1),
                      CASE WHEN st.id IS NOT NULL THEN TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')) END) AS student,
             CASE WHEN ack.acked_at IS NULL THEN NULL ELSE SUBSTR(ack.acked_at,1,10) || ' ' || SUBSTR(ack.acked_at,12,5) END AS acked_at
        FROM recipients rcp
        JOIN users u ON u.id = rcp.user_id
        LEFT JOIN guardians g ON g.id = (SELECT id FROM guardians WHERE user_id = u.id LIMIT 1)
        LEFT JOIN students st ON st.id = (SELECT id FROM students WHERE user_id = u.id LIMIT 1)
        LEFT JOIN announcement_acks ack ON ack.announcement_id = ?${rc.args.length + 2} AND ack.user_id = u.id
       ORDER BY (ack.acked_at IS NULL) DESC, 1`).bind(ann.audience_role, ...rc.args, annId).all()
    let acknowledged = 0
    const list = people.results.map((p) => {
      if (p.acked_at != null) acknowledged++
      return { name: p.name, role: p.role, student: p.student || undefined, acked_at: p.acked_at ?? undefined }
    })
    let unreachable = 0
    if (ann.audience_role !== 'staff') {
      const u = await c.db.prepare(`
        SELECT COUNT(*) AS n FROM students st LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
         WHERE st.status = 'active' AND (? OR e.section_id IN ${inList(sections)}) AND st.user_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL WHERE sg.student_id = st.id)`)
        .bind(sections.length ? 0 : 1, js(sections)).first<{ n: number }>()
      unreachable = u?.n ?? 0
    }
    return ok({
      title: ann.title, audience_role: ann.audience_role, published_at: ann.published_at,
      delivered: list.length, acknowledged, unreachable_children: unreachable, people: list,
    })
  })

  r.post('/communication/circulars/{id}/ack', 'auth', async (c) => {
    const annId = c.params.id
    if (!isUUID(annId)) throw badRequest('invalid circular id')
    const res = await resolveScope(c)
    if (res.studentIds.length === 0) throw badRequest('only a student or guardian can acknowledge a circular')
    let target = res.studentIds[0]
    const q = c.url.searchParams.get('student_id')
    if (q) {
      if (!isUUID(q) || !res.ownsStudent(q)) throw notFound('resource not found')
      target = q
    }
    // An unknown circular would otherwise fail the foreign key: a 500.
    const ann = await c.db.prepare(`SELECT 1 AS ok FROM announcements WHERE id = ?`).bind(annId).first()
    if (!ann) throw notFound('resource not found')
    await c.db.prepare(`INSERT INTO announcement_acks (announcement_id, user_id, institution_id, student_id, acked_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (announcement_id, user_id, student_id) DO UPDATE SET acked_at = excluded.acked_at`)
      .bind(annId, c.id.userId, c.id.institution!.id, target, now()).run()
    return ok({ acknowledged: true })
  })

  r.post('/communication/circulars', ANNOUNCEMENTS_WRITE, async (c) => {
    const req = await readJSON<{ title?: string; body?: string; kind?: string; audience_role?: string; section_ids?: string[]; requires_ack?: boolean
      send_sms?: boolean; send_email?: boolean; send_whatsapp?: boolean; attachment_file_id?: string }>(c.req)
    const title = req.title ?? '', body = req.body ?? ''
    if (title.trim() === '' || body.trim() === '') throw badRequest('title and body are required')
    const kind = req.kind || 'circular'
    const audience = req.audience_role || 'all'
    if (!['all', 'parents', 'students', 'staff', 'everyone'].includes(audience)) {
      throw badRequest('send to one of: all (parents and students), parents, students, staff, everyone')
    }
    const inst = c.id.institution!.id
    const annId = uuid()
    const sections = uuidsOf(req.section_ids)
    const attachment = (req.attachment_file_id ?? '').trim()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO announcements (id, institution_id, title, body, kind, audience_role, requires_ack, publish_at, created_by, attachment_file_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(annId, inst, title, body, kind, audience, req.requires_ack ? 1 : 0, now(), c.id.userId, attachment === '' ? null : attachment, now()),
      ...sections.map((sid) => c.db.prepare(`INSERT OR IGNORE INTO announcement_sections (announcement_id, section_id, institution_id) VALUES (?, ?, ?)`).bind(annId, sid, inst)),
    ]
    await c.db.batch(stmts)

    const rc = circularRecipients(sections)
    const cnt = await c.db.prepare(`SELECT COUNT(*) AS n FROM (${rc.sql}) AS t`).bind(audience, ...rc.args).first<{ n: number }>()
    let recipients = cnt?.n ?? 0, withoutLogin = 0, unreachable = 0
    if (audience !== 'staff') {
      const co = circularContactOnly(sections)
      const wl = await c.db.prepare(`SELECT COUNT(*) AS n FROM (${co.sql}) AS c`).bind(audience, ...co.args).first<{ n: number }>()
      withoutLogin = wl?.n ?? 0
      recipients += withoutLogin
      const un = await c.db.prepare(`
        SELECT COUNT(*) AS n FROM students st LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
         WHERE st.status = 'active' AND (? OR e.section_id IN ${inList(sections)}) AND st.user_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                             AND (g.user_id IS NOT NULL OR NULLIF(g.phone,'') IS NOT NULL OR g.email IS NOT NULL) WHERE sg.student_id = st.id)`)
        .bind(sections.length ? 0 : 1, js(sections)).first<{ n: number }>()
      unreachable = un?.n ?? 0
    }
    const out: Record<string, unknown> = {
      id: annId, recipients, without_login: withoutLogin, unreachable_children: unreachable,
      sms_queued: 0, email_queued: 0, whatsapp_queued: 0,
    }
    const channels = [req.send_sms && 'sms', req.send_email && 'email', req.send_whatsapp && 'whatsapp'].filter(Boolean) as string[]
    if (channels.length) {
      // The fan-out, as publishCircular: a message:send job per account per channel, then the
      // families with no account queued directly by address. Failures are swallowed, as Go.
      let msgBody = body
      if (attachment !== '') msgBody += '\n\nAttached: ' + new URL(c.req.url).origin + '/api/v1/files/' + attachment
      const queued: Record<string, number> = { sms: 0, email: 0, whatsapp: 0 }
      try {
        const to = (await c.db.prepare(rc.sql).bind(audience, ...rc.args).all<{ user_id: string }>()).results
        const jobs = to.filter((u) => u.user_id).flatMap((u) => channels.map((ch) => ({ channel: ch, template_key: 'announcement.published', to_user_id: u.user_id, vars: { title, body: msgBody } })))
        try { await enqueueMessageSends(c.env, inst, jobs); for (const j of jobs) queued[j.channel]++ } catch { /* not queued */ }
        if (audience !== 'staff') {
          const co = circularContactOnly(sections)
          const contacts = (await c.db.prepare(co.sql).bind(audience, ...co.args).all<{ phone: string; email: string }>()).results
          if (contacts.length) {
            const ms = new Messenger(scopeOf(c))
            for (const ct of contacts) for (const ch of channels) {
              const addr = ch === 'email' ? ct.email : ct.phone
              if (!addr) continue
              try {
                const r2 = await ms.queue({ channel: ch, template_code: 'announcement.published', vars: { title, body: msgBody }, recipient: addr,
                  source_kind: 'announcement', source_id: annId, occurrence_key: addr })
                if (!r2.duplicate) queued[ch]++
              } catch { /* as Go: err != nil is skipped */ }
            }
            await ms.kick()
          }
        }
      } catch (e) { console.warn('circular fan-out', e) }
      out.sms_queued = queued.sms; out.email_queued = queued.email; out.whatsapp_queued = queued.whatsapp
    }
    return created(out)
  })
}

// ============================================================ /timetable-admin

async function createSubstitution(c: Ctx) {
  const req = await readJSON<{ timetable_entry_id?: string; on_date?: string; substitute_user_id?: string; reason?: string }>(c.req)
  const entryId = req.timetable_entry_id ?? '', subId = req.substitute_user_id ?? ''
  if (!isUUID(entryId)) throw badRequest('timetable_entry_id must be a uuid')
  if (!isUUID(subId)) throw badRequest('substitute_user_id must be a uuid')
  const onDate = (req.on_date ?? '').trim()
  const d = new Date(onDate + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate) || isNaN(d.getTime())) throw badRequest('on_date must be a date')
  const isodow = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  const busy = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM timetable_entries te WHERE te.teacher_user_id = ? AND te.weekday = ?
      AND te.period_id = (SELECT period_id FROM timetable_entries WHERE id = ?)) AS b`).bind(subId, isodow, entryId).first<{ b: number }>()
  if (busy?.b) throw coded(409, 'proxy_busy', 'that teacher already has a class in this period')
  await c.db.prepare(`INSERT INTO substitutions (id, institution_id, timetable_entry_id, on_date, substitute_user_id, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (timetable_entry_id, on_date) DO UPDATE SET substitute_user_id = excluded.substitute_user_id, reason = excluded.reason, created_by = excluded.created_by`)
    .bind(uuid(), c.id.institution!.id, entryId, onDate, subId, req.reason ? req.reason : null, c.id.userId, now()).run()
  return created({ substituted: true })
}

// ============================================================ /compliance

function registerCompliance(r: Router) {
  r.get('/compliance/udise', REPORTS_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT st.admission_no, ${nameOf('st')} AS name, st.apaar_id, ${dateOf('st.date_of_birth')} AS date_of_birth,
             st.gender, st.category, c.name AS class_name, st.is_rte, st.aadhaar_consent,
             TRIM(
               CASE WHEN st.date_of_birth IS NULL THEN 'date of birth missing, ' ELSE '' END ||
               CASE WHEN st.gender IS NULL THEN 'gender missing, ' ELSE '' END ||
               CASE WHEN st.category IS NULL THEN 'social category missing, ' ELSE '' END ||
               CASE WHEN st.apaar_id IS NULL THEN 'APAAR ID not issued, ' ELSE '' END ||
               CASE WHEN NOT st.aadhaar_consent THEN 'Aadhaar consent not recorded, ' ELSE '' END ||
               CASE WHEN c.name IS NULL THEN 'not enrolled in a class, ' ELSE '' END, ', ') AS issues
        FROM students st
        LEFT JOIN classes c ON c.id = (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1)
       WHERE st.status = 'active'
       ORDER BY st.admission_no`).all()
    return ok(items(rows.results.map((v) => ({
      admission_no: v.admission_no, name: v.name, apaar_id: v.apaar_id ?? undefined, date_of_birth: v.date_of_birth ?? undefined,
      gender: v.gender ?? undefined, category: v.category ?? undefined, class_name: v.class_name ?? undefined,
      is_rte: bool(v.is_rte), aadhaar_consent: bool(v.aadhaar_consent), issues: v.issues,
    }))))
  })

  r.post('/compliance/apaar', STUDENTS_WRITE, async (c) => {
    const req = await readJSON<{ student_id?: string; apaar_id?: string; aadhaar_consent?: boolean }>(c.req)
    const sid = req.student_id ?? ''
    if (!isUUID(sid)) throw badRequest('student_id must be a uuid')
    const apaar = (req.apaar_id ?? '').trim()
    if (apaar !== '' && apaar.length !== 12) throw badRequest('apaar_id must be 12 digits')
    if (apaar !== '') {
      // students_apaar_id was a unique index in Postgres; the tenant schema has none, so the check is explicit.
      const dup = await c.db.prepare(`SELECT 1 FROM students WHERE apaar_id = ? AND id <> ?`).bind(apaar, sid).first()
      if (dup) throw coded(409, 'apaar_already_used', 'that APAAR ID is already assigned to another student')
    }
    await c.db.prepare(`UPDATE students SET apaar_id = ?, aadhaar_consent = ?, updated_at = ? WHERE id = ?`)
      .bind(apaar === '' ? null : apaar, req.aadhaar_consent ? 1 : 0, now(), sid).run()
    return ok({ student_id: sid, apaar_id: apaar })
  })
}

// ============================================================ /payroll

interface PtSlab { id?: string; state: string; from_paise: number; to_paise?: number; monthly_paise: number; february_paise?: number }
interface PayrollSettings {
  pf_enabled: boolean; pf_employee_percent: number; pf_employer_percent: number; pf_wage_ceiling_paise: number; eps_percent: number
  pf_admin_percent: number; pf_establishment_code?: string; esi_enabled: boolean; esi_employee_percent: number; esi_employer_percent: number
  esi_wage_threshold_paise: number; esi_code?: string; pt_state: string; pt_enabled: boolean; substitution_rate_paise: number
  overtime_hourly_paise: number; overtime_holiday_multiplier: number; gratuity_days: number; gratuity_month_days: number
  gratuity_min_years: number; gratuity_cap_paise: number; bank_name?: string; bank_account?: string; pt_slabs: PtSlab[]
}
interface Statutory {
  pf_wage_paise: number; pf_employee_paise: number; pf_employer_paise: number; eps_paise: number; pf_admin_paise: number
  esi_employee_paise: number; esi_employer_paise: number; pt_paise: number
}

const SETTINGS_COLUMNS = `pf_enabled, pf_employee_percent, pf_employer_percent, pf_wage_ceiling_paise, eps_percent, pf_admin_percent,
  pf_establishment_code, esi_enabled, esi_employee_percent, esi_employer_percent, esi_wage_threshold_paise, esi_code, pt_state, pt_enabled,
  substitution_rate_paise, overtime_hourly_paise, overtime_holiday_multiplier, gratuity_days, gratuity_month_days, gratuity_min_years,
  gratuity_cap_paise, bank_name, bank_account`

async function loadPayrollSettings(c: Ctx): Promise<PayrollSettings> {
  const inst = school(c).id
  const q = c.db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM payroll_settings WHERE institution_id = ?`).bind(inst)
  let row = await q.first<Record<string, unknown>>()
  if (!row) {
    await c.db.prepare(`INSERT OR IGNORE INTO payroll_settings (institution_id, updated_at) VALUES (?, ?)`).bind(inst, now()).run()
    row = await q.first<Record<string, unknown>>()
  }
  if (!row) throw new Error('payroll settings missing')
  const v: PayrollSettings = {
    pf_enabled: bool(row.pf_enabled), pf_employee_percent: numOr0(row.pf_employee_percent), pf_employer_percent: numOr0(row.pf_employer_percent),
    pf_wage_ceiling_paise: numOr0(row.pf_wage_ceiling_paise), eps_percent: numOr0(row.eps_percent), pf_admin_percent: numOr0(row.pf_admin_percent),
    pf_establishment_code: row.pf_establishment_code == null ? undefined : String(row.pf_establishment_code),
    esi_enabled: bool(row.esi_enabled), esi_employee_percent: numOr0(row.esi_employee_percent), esi_employer_percent: numOr0(row.esi_employer_percent),
    esi_wage_threshold_paise: numOr0(row.esi_wage_threshold_paise), esi_code: row.esi_code == null ? undefined : String(row.esi_code),
    pt_state: str(row.pt_state), pt_enabled: bool(row.pt_enabled), substitution_rate_paise: numOr0(row.substitution_rate_paise),
    overtime_hourly_paise: numOr0(row.overtime_hourly_paise), overtime_holiday_multiplier: numOr0(row.overtime_holiday_multiplier),
    gratuity_days: numOr0(row.gratuity_days), gratuity_month_days: numOr0(row.gratuity_month_days), gratuity_min_years: numOr0(row.gratuity_min_years),
    gratuity_cap_paise: numOr0(row.gratuity_cap_paise), bank_name: row.bank_name == null ? undefined : String(row.bank_name),
    bank_account: row.bank_account == null ? undefined : String(row.bank_account), pt_slabs: [],
  }
  const slabs = await c.db.prepare(`SELECT id, state, from_paise, to_paise, monthly_paise, february_paise FROM pt_slabs
      WHERE institution_id = ? AND state = ? ORDER BY from_paise`).bind(inst, v.pt_state).all<Record<string, unknown>>()
  v.pt_slabs = slabs.results.map((s) => ({
    id: str(s.id), state: str(s.state), from_paise: numOr0(s.from_paise), to_paise: num(s.to_paise) ?? undefined,
    monthly_paise: numOr0(s.monthly_paise), february_paise: num(s.february_paise) ?? undefined,
  }))
  return v
}

const pct = (amount: number, percent: number) => Math.floor((amount * percent) / 100 + 0.5)

function professionalTax(slabs: PtSlab[], gross: number, month: number): number {
  for (const sl of slabs) {
    if (gross < sl.from_paise) continue
    if (sl.to_paise != null && gross >= sl.to_paise) continue
    if (month === 2 && sl.february_paise != null) return sl.february_paise
    return sl.monthly_paise
  }
  return 0
}

function computeStatutory(set: PayrollSettings, basicPlusDA: number, gross: number, month: number): Statutory {
  const out: Statutory = { pf_wage_paise: 0, pf_employee_paise: 0, pf_employer_paise: 0, eps_paise: 0, pf_admin_paise: 0, esi_employee_paise: 0, esi_employer_paise: 0, pt_paise: 0 }
  if (set.pf_enabled && basicPlusDA > 0) {
    let wage = basicPlusDA
    if (set.pf_wage_ceiling_paise > 0 && wage > set.pf_wage_ceiling_paise) wage = set.pf_wage_ceiling_paise
    out.pf_wage_paise = wage
    out.pf_employee_paise = pct(wage, set.pf_employee_percent)
    const employer = pct(wage, set.pf_employer_percent)
    out.eps_paise = Math.min(pct(wage, set.eps_percent), employer)
    out.pf_employer_paise = employer - out.eps_paise
    out.pf_admin_paise = pct(wage, set.pf_admin_percent)
  }
  if (set.esi_enabled && gross > 0 && gross <= set.esi_wage_threshold_paise) {
    out.esi_employee_paise = pct(gross, set.esi_employee_percent)
    out.esi_employer_paise = pct(gross, set.esi_employer_percent)
  }
  if (set.pt_enabled) out.pt_paise = professionalTax(set.pt_slabs, gross, month)
  return out
}

/** ?year=&month= from the query, defaulting to last month. */
function periodFrom(c: Ctx): [number, number] {
  let y = Number(c.url.searchParams.get('year') ?? 0) || 0
  let m = Number(c.url.searchParams.get('month') ?? 0) || 0
  if (y === 0 || m < 1 || m > 12) {
    const n = nowIST()
    y = n.getUTCFullYear(); m = n.getUTCMonth()
    if (m === 0) { y--; m = 12 }
  }
  return [y, m]
}
function currentFY(): number {
  const n = nowIST()
  return n.getUTCMonth() + 1 < 4 ? n.getUTCFullYear() - 1 : n.getUTCFullYear()
}
function fyFrom(c: Ctx): number {
  const v = Number(c.url.searchParams.get('fy') ?? 0)
  return Number.isInteger(v) && v > 2000 ? v : currentFY()
}
const parseJSON = (v: unknown): unknown => { if (typeof v !== 'string') return v ?? {}; try { return JSON.parse(v) } catch { return {} } }
const rupees = (p: number) => `₹${Math.trunc(p / 100)}`

// ------------------------------------------------------------ loss of pay

/*
Port of staff_lop_register(p_year, p_month) from migrations/00244_lop_shifts_and_quota.sql:
the month's attendance turned into days of loss of pay under the school's own
leave policy, shifts, holidays and leave quotas.
*/
interface LopRow { lop_days: number; expected_days: number }

function intList(raw: unknown, dflt: number[]): number[] {
  const s = str(raw).trim()
  if (s === '' || s === '{}' || s === '[]') return dflt
  const body = s.replace(/^[\[{]|[\]}]$/g, '')
  const out = body.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n))
  return out.length ? out : dflt
}
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

async function lopRegister(c: Ctx, year: number, month: number): Promise<Map<string, LopRow>> {
  const inst = c.id.institution!.id
  const firstDay = `${year}-${pad2(month)}-01`
  const lastDay = `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`
  const polRow = await c.db.prepare(`SELECT * FROM leave_policy WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
  const pol = {
    halfDay: polRow ? numOr0(polRow.half_day_fraction) : 0.5,
    shiftStartsAt: polRow ? str(polRow.shift_starts_at) : '09:00',
    grace: polRow ? numOr0(polRow.grace_minutes) : 10,
    lateMarksPerDay: polRow ? numOr0(polRow.late_marks_per_lop_day) : 3,
    lateHalfDayAfter: polRow ? num(polRow.late_half_day_after_minutes) : null,
    lopOnAbsent: polRow ? bool(polRow.lop_on_absent) : true,
    lopOnUnpaid: polRow ? bool(polRow.lop_on_unpaid_leave) : true,
    lopOnQuota: polRow ? bool(polRow.lop_on_exhausted_quota) : true,
    rounding: polRow ? str(polRow.lop_rounding) : 'half',
    maxPerMonth: polRow ? num(polRow.max_lop_days_per_month) : null,
  }
  const ay = await c.db.prepare(`SELECT starts_on FROM academic_years WHERE ? BETWEEN starts_on AND ends_on ORDER BY is_current DESC LIMIT 1`)
    .bind(firstDay).first<{ starts_on: string }>()
  const yearFrom = ay?.starts_on ?? `${year}-01-01`

  const shifts = await c.db.prepare(`
    SELECT e.id AS eid, e.user_id AS uid,
           COALESCE(p1.starts_at, p2.starts_at, p3.starts_at) AS starts_at,
           COALESCE(p1.grace_minutes, p2.grace_minutes, p3.grace_minutes) AS grace,
           COALESCE(p1.working_days, p2.working_days, p3.working_days) AS working_days
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id
      LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
      LEFT JOIN work_patterns p3 ON p3.id = (SELECT id FROM work_patterns WHERE is_default LIMIT 1)`).all<Record<string, unknown>>()
  const shift = new Map<string, { uid: string | null; startsAt: number; grace: number; workingDays: number[] }>()
  for (const s of shifts.results) {
    shift.set(str(s.eid), {
      uid: s.uid == null ? null : String(s.uid),
      startsAt: minutesOf(str(s.starts_at) || pol.shiftStartsAt),
      grace: s.grace == null ? pol.grace : numOr0(s.grace),
      workingDays: intList(s.working_days, [1, 2, 3, 4, 5, 6]),
    })
  }
  const holidays = await c.db.prepare(`SELECT on_date, COALESCE(to_date, on_date) AS to_date FROM holidays
      WHERE kind IN ('holiday','vacation') AND applies_to IN ('all','staff') AND on_date <= ? AND COALESCE(to_date, on_date) >= ?`)
    .bind(lastDay, firstDay).all<{ on_date: string; to_date: string }>()
  const nDays = daysInMonth(year, month)
  const expected = new Map<string, number>()
  for (const [eid, sh] of shift) {
    let n = 0
    for (let d = 1; d <= nDays; d++) {
      const day = `${year}-${pad2(month)}-${pad2(d)}`
      const dow = new Date(day + 'T00:00:00Z').getUTCDay()
      const isodow = dow === 0 ? 7 : dow
      if (!sh.workingDays.includes(isodow)) continue
      if (holidays.results.some((h) => day >= h.on_date && day <= h.to_date)) continue
      n++
    }
    expected.set(eid, n)
  }

  // Every leave day of the year so far, with the request that covers it.
  const leave = await c.db.prepare(`
    SELECT e.id AS eid, sa.on_date, lr.is_half_day, lr.leave_type_id, lt.is_paid, lt.annual_quota,
           (SELECT lb.entitled FROM leave_balances lb WHERE lb.employee_id = e.id AND lb.leave_type_id = lr.leave_type_id ORDER BY lb.academic_year_id LIMIT 1) AS entitled
      FROM staff_attendance sa
      JOIN employees e ON e.user_id = sa.user_id
      JOIN leave_requests lr ON lr.id = (SELECT r.id FROM leave_requests r WHERE r.employee_id = e.id AND r.subject_kind = 'staff' AND r.status = 'approved'
                                          AND sa.on_date BETWEEN r.from_date AND r.to_date ORDER BY r.from_date DESC LIMIT 1)
      LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE sa.status = 'leave' AND lr.leave_type_id IS NOT NULL AND sa.on_date BETWEEN ? AND ?
     ORDER BY e.id, lr.leave_type_id, sa.on_date`).bind(yearFrom, lastDay).all<Record<string, unknown>>()
  const excess = new Map<string, number>() // eid|date -> days past the quota
  const cum = new Map<string, number>()
  for (const l of leave.results) {
    const key = `${l.eid}|${l.leave_type_id}`
    const d = bool(l.is_half_day) ? 0.5 : 1
    const c2 = (cum.get(key) ?? 0) + d
    cum.set(key, c2)
    const paid = l.is_paid == null ? true : bool(l.is_paid)
    const quota = l.entitled != null ? num(l.entitled) : num(l.annual_quota)
    if (paid && quota != null) excess.set(`${l.eid}|${l.on_date}`, Math.max(0, Math.min(d, c2 - quota)))
  }

  const marked = await c.db.prepare(`
    SELECT e.id AS eid, sa.status, sa.check_in, sa.on_date, lr.is_half_day, lt.is_paid
      FROM staff_attendance sa
      JOIN employees e ON e.user_id = sa.user_id
      LEFT JOIN leave_requests lr ON lr.id = (SELECT r.id FROM leave_requests r WHERE r.employee_id = e.id AND r.subject_kind = 'staff' AND r.status = 'approved'
                                               AND sa.on_date BETWEEN r.from_date AND r.to_date ORDER BY r.from_date DESC LIMIT 1)
      LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE sa.on_date BETWEEN ? AND ?`).bind(firstDay, lastDay).all<Record<string, unknown>>()
  interface Tally { charged: number; marks: number }
  const tally = new Map<string, Tally>()
  for (const m of marked.results) {
    const eid = str(m.eid)
    const sh = shift.get(eid)
    if (!sh) continue
    const status = str(m.status)
    const halfLeave = bool(m.is_half_day)
    const paidLeave = m.is_paid == null ? false : bool(m.is_paid)
    const quotaExcess = excess.get(`${eid}|${m.on_date}`) ?? 0
    let late: number | null = null
    if (m.check_in != null) {
      const t = new Date(String(m.check_in))
      if (!isNaN(t.getTime())) {
        const ist = new Date(t.getTime() + 5.5 * 3600 * 1000)
        late = Math.max(0, ist.getUTCHours() * 60 + ist.getUTCMinutes() - sh.startsAt)
      }
    }
    let charged = 0
    if (status === 'absent') charged = pol.lopOnAbsent ? 1 : 0
    else if (status === 'half_day') charged = pol.halfDay
    else if (status === 'leave') {
      if (pol.lopOnUnpaid && !paidLeave) charged = halfLeave ? pol.halfDay : 1
      else if (pol.lopOnQuota) charged = quotaExcess
    } else if (pol.lateHalfDayAfter != null && (late ?? 0) >= pol.lateHalfDayAfter) charged = pol.halfDay
    let lateMark = 0
    if (['absent', 'half_day', 'leave', 'holiday', 'week_off'].includes(status)) lateMark = 0
    else if (pol.lateHalfDayAfter != null && (late ?? 0) >= pol.lateHalfDayAfter) lateMark = 0
    else if (status === 'late' || (late ?? 0) > sh.grace) lateMark = 1
    const t = tally.get(eid) ?? { charged: 0, marks: 0 }
    t.charged += charged; t.marks += lateMark
    tally.set(eid, t)
  }
  const out = new Map<string, LopRow>()
  for (const [eid, t] of tally) {
    const gross = t.charged + Math.floor(t.marks / (pol.lateMarksPerDay || 3))
    let v = pol.rounding === 'up' ? Math.ceil(gross) : pol.rounding === 'half' ? Math.round(gross * 2) / 2 : gross
    if (pol.maxPerMonth != null) v = Math.min(v, pol.maxPerMonth)
    v = Math.min(v, nDays)
    out.set(eid, { lop_days: Number(v.toFixed(2)), expected_days: expected.get(eid) ?? 0 })
  }
  for (const [eid] of shift) if (!out.has(eid)) out.set(eid, { lop_days: 0, expected_days: expected.get(eid) ?? 0 })
  return out
}

// ------------------------------------------------------------ the run

async function runPayroll(c: Ctx) {
  const req = await readJSON<{ month?: number; year?: number; acknowledge_unmarked_attendance?: boolean }>(c.req)
  const month = Number(req.month ?? 0), year = Number(req.year ?? 0)
  if (month < 1 || month > 12 || year < 2000) throw badRequest('month must be 1-12 and year must be valid')
  const inst = c.id.institution!.id
  const key = `${year}-${pad2(month)}`

  if (!req.acknowledge_unmarked_attendance) {
    const gap = await c.db.prepare(`
      SELECT COUNT(*) AS staff, COALESCE(SUM(MAX(0, ?2 - marked)), 0) AS days FROM (
        SELECT e.id, (SELECT COUNT(*) FROM staff_attendance sa WHERE sa.user_id = e.user_id AND SUBSTR(sa.on_date,1,7) = ?1) AS marked
          FROM employees e WHERE e.status = 'active' AND e.user_id IS NOT NULL) t
       WHERE marked = 0`).bind(key, daysInMonth(year, month)).first<{ staff: number; days: number }>()
    if (gap && gap.staff > 0) {
      throw new HttpError(409,
        `${gap.staff} staff have no attendance marked for this month. Their days will be paid in full, and loss of pay will deduct nothing. Acknowledge to run anyway.`,
        { code: 'attendance_unmarked', unmarked: { staff_with_no_marks: gap.staff, unmarked_days: gap.days } })
    }
  }

  await requireOpenMonth(c, year, month)
  let run = await c.db.prepare(`SELECT id, status, bank_file_drawn_at FROM payroll_runs WHERE institution_id = ? AND period_year = ? AND period_month = ?`)
    .bind(inst, year, month).first<{ id: string; status: string; bank_file_drawn_at: string | null }>()
  if (!run) {
    const id = uuid()
    await c.db.prepare(`INSERT INTO payroll_runs (id, institution_id, period_month, period_year, status, run_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)`)
      .bind(id, inst, month, year, c.id.userId, now()).run()
    run = { id, status: 'draft', bank_file_drawn_at: null }
  } else {
    await c.db.prepare(`UPDATE payroll_runs SET run_by = ? WHERE id = ?`).bind(c.id.userId, run.id).run()
  }
  if (run.status === 'locked' || run.status === 'paid') {
    throw coded(409, 'payroll_locked', "this month's payroll is locked; payslips already issued cannot be recomputed")
  }
  if (run.bank_file_drawn_at) {
    throw coded(409, 'payroll_exported', "this month's salary file has already gone to the bank; its payslips cannot be recomputed")
  }
  const runId = run.id
  const nDays = daysInMonth(year, month)
  const set = await loadPayrollSettings(c)
  const lop = await lopRegister(c, year, month)
  const firstDay = `${key}-01`
  const emps = await c.db.prepare(`
    SELECT e.id, e.user_id, ss.id AS structure, COALESCE(p.lop_basis, 'salary') AS lop_basis, COALESCE(p.salary_divisor, 0) AS divisor
      FROM employees e
      JOIN salary_structures ss ON ss.employee_id = e.id AND ss.effective_from <= ?1 AND (ss.effective_to IS NULL OR ss.effective_to >= ?1)
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN work_patterns p ON p.id = COALESCE(e.work_pattern_id, d.work_pattern_id, (SELECT dp.id FROM work_patterns dp WHERE dp.is_default LIMIT 1))
     WHERE e.status = 'active' AND e.user_id IS NOT NULL`).bind(firstDay)
    .all<{ id: string; user_id: string; structure: string; lop_basis: string; divisor: number }>()

  const stmts: D1PreparedStatement[] = [c.db.prepare(`DELETE FROM payslips WHERE payroll_run_id = ?`).bind(runId)]
  let employees = 0, gross = 0, deduction = 0, net = 0
  for (const e of emps.results) {
    const l = lop.get(e.id) ?? { lop_days: 0, expected_days: 0 }
    let base = nDays
    if (e.divisor > 0) base = e.divisor
    else if (l.expected_days > 0) base = l.expected_days
    let paidDays = Math.max(0, base - l.lop_days)
    let ratio = paidDays / base
    if (e.lop_basis === 'none') { ratio = 1; paidDays = base }

    let earn = 0, deduct = 0, basicDA = 0
    const breakup: Record<string, number> = {}
    const comps = await c.db.prepare(`SELECT sc.code, sc.kind, ssi.amount_paise FROM salary_structure_items ssi
        JOIN salary_components sc ON sc.id = ssi.component_id WHERE ssi.salary_structure_id = ? ORDER BY sc.sequence`).bind(e.structure)
      .all<{ code: string; kind: string; amount_paise: number }>()
    for (const cmp of comps.results) {
      if (cmp.kind === 'earning') {
        const v = Math.trunc(cmp.amount_paise * ratio)
        earn += v; breakup[cmp.code] = v
        if (cmp.code === 'BASIC' || cmp.code === 'DA') basicDA += v
      } else if (cmp.kind === 'deduction') {
        if (cmp.code === 'PF' || cmp.code === 'ESI' || cmp.code === 'PT') continue
        deduct += cmp.amount_paise; breakup[cmp.code] = -cmp.amount_paise
      }
    }
    if (set.substitution_rate_paise > 0) {
      const p = await c.db.prepare(`SELECT COUNT(*) AS n FROM substitutions sub WHERE sub.substitute_user_id = ? AND SUBSTR(sub.on_date,1,7) = ?`)
        .bind(e.user_id, key).first<{ n: number }>()
      if (p && p.n > 0) { const v = p.n * set.substitution_rate_paise; earn += v; breakup.SUBST = v }
    }
    const st = computeStatutory(set, basicDA, earn, month)
    for (const [code, amt] of [['PF', st.pf_employee_paise], ['ESI', st.esi_employee_paise], ['PT', st.pt_paise]] as [string, number][]) {
      if (amt > 0) { deduct += amt; breakup[code] = -amt }
    }
    for (const [code, amt] of [['PF_EMPLOYER', st.pf_employer_paise], ['EPS', st.eps_paise], ['ESI_EMPLOYER', st.esi_employer_paise]] as [string, number][]) {
      if (amt > 0) breakup[code] = amt
    }
    const loans = await c.db.prepare(`
      SELECT l.id, l.instalment_paise, MAX(0, l.principal_paise - COALESCE((SELECT SUM(ld.amount_paise) FROM loan_deductions ld WHERE ld.loan_id = l.id), 0)) AS owing
        FROM staff_loans l WHERE l.employee_id = ? AND l.status = 'active' AND ? >= (l.start_year * 100 + l.start_month)`)
      .bind(e.id, year * 100 + month).all<{ id: string; instalment_paise: number; owing: number }>()
    let loanCut = 0
    for (const d of loans.results) {
      if (d.owing <= 0) continue
      const take = Math.min(d.instalment_paise, d.owing)
      stmts.push(c.db.prepare(`INSERT INTO loan_deductions (id, institution_id, loan_id, payroll_run_id, period_year, period_month, amount_paise, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (loan_id, period_year, period_month) DO UPDATE SET amount_paise = excluded.amount_paise, payroll_run_id = excluded.payroll_run_id`)
        .bind(uuid(), inst, d.id, runId, year, month, take, now()))
      loanCut += take
      if (take >= d.owing) stmts.push(c.db.prepare(`UPDATE staff_loans SET status = 'closed', closed_on = ? WHERE id = ?`).bind(todayIST(), d.id))
    }
    if (loanCut > 0) { deduct += loanCut; breakup.ADVANCE = -loanCut }

    stmts.push(c.db.prepare(`INSERT INTO payslips (id, institution_id, payroll_run_id, employee_id, paid_days, lop_days, gross_paise, deduction_paise, net_paise, breakup, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst, runId, e.id, String(paidDays), String(l.lop_days), earn, deduct, earn - deduct, JSON.stringify(breakup), now()))
    employees++; gross += earn; deduction += deduct; net += earn - deduct
  }
  stmts.push(c.db.prepare(`UPDATE payroll_runs SET status = 'processed', employees = ?, gross_paise = ?, deduction_paise = ?, net_paise = ? WHERE id = ?`)
    .bind(employees, gross, deduction, net, runId))
  await c.db.batch(stmts)
  return ok({ payroll_run_id: runId, employees, gross_paise: gross, deduction_paise: deduction, net_paise: net })
}

async function setPayrollState(c: Ctx) {
  let body: { month?: number; year?: number; to?: string }
  try { body = await c.req.json() } catch { throw badRequest('Send a month and what to do with it.') }
  const month = Number(body.month ?? 0), year = Number(body.year ?? 0), to = body.to ?? ''
  if (month < 1 || month > 12 || year < 2000) throw badRequest('Choose a month.')
  let from: string[]
  switch (to) {
    case 'locked': from = ['draft', 'processed']; break
    case 'paid': from = ['locked']; break
    case 'published': from = ['paid', 'locked']; break
    case 'draft': from = ['locked']; break
    default: throw badRequest('A month can be locked, marked paid, published, or unlocked.')
  }
  const status = to === 'published' ? 'paid' : to
  const run = await c.db.prepare(`SELECT id FROM payroll_runs WHERE period_month = ? AND period_year = ? AND status IN ${inList(from)}`)
    .bind(month, year, js(from)).first<{ id: string }>()
  if (!run) throw badRequest('That month is not at a stage where this can be done. Lock it before drawing the bank file, and pay it before publishing.')
  const ts = now()
  await c.db.prepare(`UPDATE payroll_runs SET status = ?2,
        locked_at = CASE WHEN ?2 = 'draft' THEN NULL WHEN locked_at IS NULL THEN ?3 ELSE locked_at END,
        published_at = CASE WHEN ?4 THEN ?3 WHEN ?2 = 'draft' THEN NULL ELSE published_at END
      WHERE id = ?1`).bind(run.id, status, ts, to === 'published' ? 1 : 0).run()
  let told = 0
  if (to === 'published') {
    const people = await c.db.prepare(`SELECT e.user_id, ${EMP_NAME} AS name, ps.net_paise FROM payslips ps JOIN employees e ON e.id = ps.employee_id
        WHERE ps.payroll_run_id = ? AND e.user_id IS NOT NULL`).bind(run.id).all<{ user_id: string; name: string; net_paise: number }>()
    const mon = MONTHS[month - 1]
    const stmts = people.results.map((p) => c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, created_at)
        VALUES (?, ?, ?, 'payslip', ?, ?, '/go/my_profile/my_pay', ?)`)
      .bind(uuid(), c.id.institution!.id, p.user_id, `Your payslip for ${mon} is ready`,
        `${mon} ${year}. Take-home ${rupees(p.net_paise)}. Open My pay to see what was taken off.`, now()))
    if (stmts.length) await c.db.batch(stmts)
    told = stmts.length
  }
  // emailPayslips: one payroll.payslip email per person with an address, keyed run:email.
  let emailed = 0, emailFailed = 0
  if (to === 'published') {
    const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const people = (await c.db.prepare(`SELECT ${EMP_NAME} AS name, COALESCE(e.email,'') AS email, ps.net_paise FROM payslips ps JOIN employees e ON e.id = ps.employee_id
        WHERE ps.payroll_run_id = ? AND e.user_id IS NOT NULL AND COALESCE(e.email,'') <> ''`).bind(run.id).all<{ name: string; email: string; net_paise: number }>()).results
    const school = c.id.institution!.name
    const ms = new Messenger(scopeOf(c))
    for (const p of people) {
      try {
        await ms.queue({ channel: 'email', template_code: 'payroll.payslip', recipient: p.email, source_kind: 'payroll_run', occurrence_key: `${run.id}:${p.email}`,
          vars: { staff_name: p.name, month: FULL[month - 1], year, net_pay: rupees(p.net_paise), school_name: school } })
        emailed++
      } catch (e) { console.warn('payslip email', e); emailFailed++ }
    }
    await ms.kick()
  }
  return ok({ state: to, notified: told, emailed, email_failed: emailFailed })
}

// ------------------------------------------------------------ routes

interface SalaryComponent { id: string; code: string; name: string; kind: string; sequence: number; is_percent: boolean; percent_of?: string; is_statutory: boolean }
const starterComponents: SalaryComponent[] = [
  { id: '', code: 'BASIC', name: 'Basic pay', kind: 'earning', sequence: 10, is_percent: false, is_statutory: false },
  { id: '', code: 'DA', name: 'Dearness allowance', kind: 'earning', sequence: 20, is_percent: false, is_statutory: false },
  { id: '', code: 'HRA', name: 'House rent allowance', kind: 'earning', sequence: 30, is_percent: true, percent_of: 'BASIC', is_statutory: false },
  { id: '', code: 'CONVEY', name: 'Conveyance', kind: 'earning', sequence: 40, is_percent: false, is_statutory: false },
  { id: '', code: 'SPECIAL', name: 'Special allowance', kind: 'earning', sequence: 50, is_percent: false, is_statutory: false },
  { id: '', code: 'PF', name: 'Provident fund', kind: 'deduction', sequence: 60, is_percent: true, percent_of: 'BASIC', is_statutory: true },
  { id: '', code: 'PT', name: 'Professional tax', kind: 'deduction', sequence: 70, is_percent: false, is_statutory: true },
  { id: '', code: 'TDS', name: 'Income tax (TDS)', kind: 'deduction', sequence: 80, is_percent: false, is_statutory: true },
]

function registerPayrollGroup(r: Router) {
  r.get('/payroll/payslips', PAYROLL_READ, async (c) => {
    const month = num(c.url.searchParams.get('month')), year = num(c.url.searchParams.get('year'))
    const rows = await c.db.prepare(`
      SELECT e.employee_code, ${EMP_NAME} AS full_name, CAST(ps.paid_days AS TEXT) AS paid_days, CAST(ps.lop_days AS TEXT) AS lop_days,
             ps.gross_paise, ps.deduction_paise, ps.net_paise, ps.breakup, pr.status AS run_status,
             pr.published_at IS NOT NULL AS published, e.status <> 'active' AS left_service
        FROM payslips ps JOIN employees e ON e.id = ps.employee_id JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
       WHERE (?1 IS NULL OR pr.period_month = ?1) AND (?2 IS NULL OR pr.period_year = ?2)
       ORDER BY e.employee_code`).bind(month, year).all()
    return ok(items(rows.results.map((v) => ({
      employee_code: v.employee_code, full_name: v.full_name, paid_days: str(v.paid_days), lop_days: str(v.lop_days),
      gross_paise: numOr0(v.gross_paise), deduction_paise: numOr0(v.deduction_paise), net_paise: numOr0(v.net_paise),
      breakup: parseJSON(v.breakup), run_status: v.run_status, published: bool(v.published), left_service: bool(v.left_service),
    }))))
  })
  // The Go route also wraps runPayroll in RequireFresh (a recent sign-in); the worker's router has no such gate.
  // Go mounts this behind RequireFresh: a payroll run moves money.
  r.post('/payroll/run', PAYROLL_WRITE, async (c) => { await requireFresh(c); return runPayroll(c) })
  r.post('/payroll/state', PAYROLL_WRITE, setPayrollState)

  r.get('/payroll/components', PAYROLL_READ, async (c) => {
    const rows = await c.db.prepare(`SELECT id, code, name, kind, sequence, is_percent, percent_of, is_statutory FROM salary_components ORDER BY sequence, name`).all()
    return ok({
      items: rows.results.map((v) => ({
        id: v.id, code: v.code, name: v.name, kind: v.kind, sequence: numOr0(v.sequence), is_percent: bool(v.is_percent),
        percent_of: v.percent_of ?? undefined, is_statutory: bool(v.is_statutory),
      })),
      suggested: starterComponents.map((s) => ({ ...s, percent_of: s.percent_of })),
    })
  })
  r.post('/payroll/components', PAYROLL_WRITE, async (c) => {
    let body: { starters?: boolean; code?: string; name?: string; kind?: string; is_percent?: boolean; percent_of?: string | null }
    try { body = await c.req.json() } catch { throw badRequest('Send a component.') }
    let wanted: SalaryComponent[]
    if (body.starters) wanted = starterComponents
    else {
      const code = (body.code ?? '').trim().toUpperCase(), name = (body.name ?? '').trim()
      if (code === '' || name === '') throw badRequest('A component needs a short code and a name.')
      if (!['earning', 'deduction', 'employer_contribution'].includes(body.kind ?? '')) {
        throw badRequest("A component is either something added to pay, something taken off, or the employer's own contribution.")
      }
      wanted = [{ id: '', code, name, kind: body.kind!, sequence: 100, is_percent: !!body.is_percent, percent_of: body.percent_of ?? undefined, is_statutory: false }]
    }
    const results = await c.db.batch(wanted.map((w) => c.db.prepare(`INSERT OR IGNORE INTO salary_components
        (id, institution_id, code, name, kind, sequence, is_percent, percent_of, is_statutory) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), c.id.institution!.id, w.code, w.name, w.kind, w.sequence, w.is_percent ? 1 : 0, w.percent_of ?? null, w.is_statutory ? 1 : 0)))
    return ok({ created: results.reduce((s, x) => s + x.meta.changes, 0) })
  })
  r.del('/payroll/components/{id}', PAYROLL_WRITE, async (c) => {
    const cid = c.params.id
    if (!isUUID(cid)) throw badRequest('invalid id')
    const used = await c.db.prepare(`SELECT 1 FROM salary_structure_items WHERE component_id = ? LIMIT 1`).bind(cid).first()
    if (used) throw coded(409, 'in_use', 'a salary uses this component; remove it from salaries first')
    const d = await c.db.prepare(`DELETE FROM salary_components WHERE id = ?`).bind(cid).run()
    if (!d.meta.changes) throw notFound('resource not found')
    return ok({ ok: true })
  })

  r.get('/payroll/structures', PAYROLL_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT e.id AS employee_id, e.employee_code, ${EMP_NAME} AS full_name, ss.id AS structure_id, ${dateOf('ss.effective_from')} AS effective_from,
             COALESCE(ss.ctc_paise, 0) AS ctc_paise
        FROM employees e LEFT JOIN salary_structures ss ON ss.employee_id = e.id AND ss.effective_to IS NULL
       WHERE e.status = 'active' ORDER BY e.employee_code`).all()
    const out = rows.results.map((v) => ({
      employee_id: String(v.employee_id), employee_code: v.employee_code, full_name: v.full_name,
      structure_id: v.structure_id == null ? undefined : String(v.structure_id), effective_from: v.effective_from ?? undefined,
      ctc_paise: numOr0(v.ctc_paise), items: [] as { component_id: string; code: string; name: string; kind: string; amount_paise: number; percent?: number }[],
    }))
    const byStructure = new Map(out.filter((o) => o.structure_id).map((o) => [o.structure_id!, o]))
    if (byStructure.size > 0) {
      const ids = [...byStructure.keys()]
      const it = await c.db.prepare(`SELECT ssi.salary_structure_id AS sid, sc.id AS component_id, sc.code, sc.name, sc.kind, ssi.amount_paise, ssi.percent
          FROM salary_structure_items ssi JOIN salary_components sc ON sc.id = ssi.component_id
         WHERE ssi.salary_structure_id IN ${inList(ids)} ORDER BY sc.sequence, sc.name`).bind(js(ids)).all()
      for (const v of it.results) {
        byStructure.get(String(v.sid))?.items.push({
          component_id: String(v.component_id), code: String(v.code), name: String(v.name), kind: String(v.kind),
          amount_paise: numOr0(v.amount_paise), percent: num(v.percent) ?? undefined,
        })
      }
    }
    return ok(items(out))
  })
  r.post('/payroll/structures', PAYROLL_WRITE, async (c) => {
    let body: { employee_id?: string; effective_from?: string; items?: { component_id: string; amount_paise?: number; percent?: number | null }[] }
    try { body = await c.req.json() } catch { throw badRequest('Send a salary.') }
    const empId = (body.employee_id ?? '').trim()
    if (!isUUID(empId)) throw badRequest('Choose whose salary this is.')
    const from = (body.effective_from ?? '').trim()
    if (from === '') throw badRequest('Say which date this pay starts from.')
    const list = body.items ?? []
    if (list.length === 0) throw badRequest('A salary with no lines in it pays nothing. Add at least basic pay.')
    for (const it of list) if (!isUUID(it.component_id)) throw badRequest('invalid UUID format')
    const dayBefore = new Date(from + 'T00:00:00Z'); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
    const total = list.reduce((s, it) => s + numOr0(it.amount_paise), 0)
    const newId = uuid()
    const inst = c.id.institution!.id
    await c.db.batch([
      c.db.prepare(`UPDATE salary_structures SET effective_to = ? WHERE employee_id = ? AND effective_to IS NULL AND effective_from < ?`)
        .bind(dayBefore.toISOString().slice(0, 10), empId, from),
      c.db.prepare(`DELETE FROM salary_structure_items WHERE salary_structure_id IN (SELECT id FROM salary_structures WHERE employee_id = ? AND effective_from = ?)`).bind(empId, from),
      c.db.prepare(`DELETE FROM salary_structures WHERE employee_id = ? AND effective_from = ?`).bind(empId, from),
      c.db.prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(newId, inst, empId, from, total * 12, now()),
      ...list.map((it) => c.db.prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise, percent) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, newId, it.component_id, numOr0(it.amount_paise), it.percent == null ? null : String(it.percent))),
    ])
    return ok({ structure_id: newId })
  })
  r.del('/payroll/structures/{id}', PAYROLL_WRITE, async (c) => {
    const sid = c.params.id
    if (!isUUID(sid)) throw badRequest('invalid id')
    const [, d] = await c.db.batch([
      c.db.prepare(`DELETE FROM salary_structure_items WHERE salary_structure_id = ?`).bind(sid),
      c.db.prepare(`DELETE FROM salary_structures WHERE id = ?`).bind(sid),
    ])
    if (!d.meta.changes) throw notFound('resource not found')
    return ok({ ok: true })
  })

  r.get('/payroll/settings', PAYROLL_READ, async (c) => ok(await loadPayrollSettings(c)))
  r.put('/payroll/settings', PAYROLL_WRITE, async (c) => {
    const s = await readJSON<Partial<PayrollSettings>>(c.req)
    const inst = c.id.institution!.id
    const n = (v: unknown) => numOr0(v)
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO payroll_settings (institution_id, pf_enabled, pf_employee_percent, pf_employer_percent, pf_wage_ceiling_paise, eps_percent, pf_admin_percent,
          pf_establishment_code, esi_enabled, esi_employee_percent, esi_employer_percent, esi_wage_threshold_paise, esi_code, pt_state, pt_enabled,
          substitution_rate_paise, overtime_hourly_paise, overtime_holiday_multiplier, gratuity_days, gratuity_month_days, gratuity_min_years,
          gratuity_cap_paise, bank_name, bank_account, updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)
        ON CONFLICT (institution_id) DO UPDATE SET pf_enabled = ?2, pf_employee_percent = ?3, pf_employer_percent = ?4, pf_wage_ceiling_paise = ?5,
          eps_percent = ?6, pf_admin_percent = ?7, pf_establishment_code = ?8, esi_enabled = ?9, esi_employee_percent = ?10, esi_employer_percent = ?11,
          esi_wage_threshold_paise = ?12, esi_code = ?13, pt_state = ?14, pt_enabled = ?15, substitution_rate_paise = ?16, overtime_hourly_paise = ?17,
          overtime_holiday_multiplier = ?18, gratuity_days = ?19, gratuity_month_days = ?20, gratuity_min_years = ?21, gratuity_cap_paise = ?22,
          bank_name = ?23, bank_account = ?24, updated_at = ?25`)
        .bind(inst, s.pf_enabled ? 1 : 0, String(n(s.pf_employee_percent)), String(n(s.pf_employer_percent)), n(s.pf_wage_ceiling_paise),
          String(n(s.eps_percent)), String(n(s.pf_admin_percent)), s.pf_establishment_code ?? null, s.esi_enabled ? 1 : 0,
          String(n(s.esi_employee_percent)), String(n(s.esi_employer_percent)), n(s.esi_wage_threshold_paise), s.esi_code ?? null,
          s.pt_state ?? '', s.pt_enabled ? 1 : 0, n(s.substitution_rate_paise), n(s.overtime_hourly_paise), String(n(s.overtime_holiday_multiplier)),
          n(s.gratuity_days), n(s.gratuity_month_days), n(s.gratuity_min_years), n(s.gratuity_cap_paise), s.bank_name ?? null, s.bank_account ?? null, now()),
    ]
    if (s.pt_slabs != null) {
      stmts.push(c.db.prepare(`DELETE FROM pt_slabs WHERE institution_id = ? AND state = ?`).bind(inst, s.pt_state ?? ''))
      for (const sl of s.pt_slabs) {
        stmts.push(c.db.prepare(`INSERT INTO pt_slabs (id, institution_id, state, from_paise, to_paise, monthly_paise, february_paise) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), inst, s.pt_state ?? '', n(sl.from_paise), sl.to_paise ?? null, n(sl.monthly_paise), sl.february_paise ?? null))
      }
    }
    try { await c.db.batch(stmts) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ saved: true })
  })

  r.get('/payroll/statutory', PAYROLL_READ, async (c) => {
    const [year, month] = periodFrom(c)
    const set = await loadPayrollSettings(c)
    const rows = await c.db.prepare(`
      SELECT e.id AS employee_id, COALESCE(e.employee_code,'') AS employee_code, ${EMP_NAME} AS full_name, e.uan, e.esi_number, e.pan, ps.gross_paise,
             COALESCE(json_extract(ps.breakup, '$.BASIC'), 0) + COALESCE(json_extract(ps.breakup, '$.DA'), 0) AS basic_da
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
       WHERE pr.period_year = ? AND pr.period_month = ? ORDER BY e.employee_code, e.first_name`).bind(year, month).all()
    const totals: Statutory = { pf_wage_paise: 0, pf_employee_paise: 0, pf_employer_paise: 0, eps_paise: 0, pf_admin_paise: 0, esi_employee_paise: 0, esi_employer_paise: 0, pt_paise: 0 }
    const out = rows.results.map((v) => {
      const st = computeStatutory(set, numOr0(v.basic_da), numOr0(v.gross_paise), month)
      const missing: string[] = []
      if (st.pf_employee_paise > 0 && !v.uan) missing.push('UAN')
      if (st.esi_employee_paise > 0 && !v.esi_number) missing.push('ESI number')
      totals.pf_employee_paise += st.pf_employee_paise; totals.pf_employer_paise += st.pf_employer_paise; totals.eps_paise += st.eps_paise
      totals.pf_admin_paise += st.pf_admin_paise; totals.esi_employee_paise += st.esi_employee_paise; totals.esi_employer_paise += st.esi_employer_paise
      totals.pt_paise += st.pt_paise
      return {
        employee_id: v.employee_id, employee_code: v.employee_code, full_name: v.full_name, uan: v.uan ?? undefined,
        esi_number: v.esi_number ?? undefined, pan: v.pan ?? undefined, gross_paise: numOr0(v.gross_paise), basic_da_paise: numOr0(v.basic_da), ...st, missing,
      }
    })
    return ok({ items: out, totals, year, month, pf_establishment_code: set.pf_establishment_code ?? null, esi_code: set.esi_code ?? null })
  })

  r.get('/payroll/ecr', PAYROLL_READ, async (c) => {
    const [year, month] = periodFrom(c)
    const set = await loadPayrollSettings(c)
    const rows = await c.db.prepare(`
      SELECT COALESCE(e.uan,'') AS uan, ${EMP_NAME} AS name, ps.gross_paise,
             COALESCE(json_extract(ps.breakup, '$.BASIC'), 0) + COALESCE(json_extract(ps.breakup, '$.DA'), 0) AS basic_da, CAST(ps.lop_days AS REAL) AS lop
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
       WHERE pr.period_year = ? AND pr.period_month = ? ORDER BY e.uan`).bind(year, month).all()
    let b = ''
    for (const v of rows.results) {
      const st = computeStatutory(set, numOr0(v.basic_da), numOr0(v.gross_paise), month)
      if (st.pf_employee_paise === 0) continue
      const w = Math.trunc(st.pf_wage_paise / 100)
      b += [v.uan, v.name, w, w, w, 0, Math.trunc(st.pf_employee_paise / 100), Math.trunc(st.pf_employer_paise / 100), Math.trunc(st.eps_paise / 100), 0,
        Math.round(numOr0(v.lop)).toFixed(0)].join('#~#') + '\n'
    }
    return new Response(b, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="ecr-${year}-${pad2(month)}.txt"` } })
  })

  r.get('/payroll/bank-file', PAYROLL_READ, async (c) => {
    const [year, month] = periodFrom(c)
    const rows = await c.db.prepare(`
      SELECT ${EMP_NAME} AS name, COALESCE(e.bank_account,'') AS acct, COALESCE(e.bank_ifsc,'') AS ifsc, ps.net_paise
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
       WHERE pr.period_year = ? AND pr.period_month = ? ORDER BY e.employee_code, e.first_name`).bind(year, month)
      .all<{ name: string; acct: string; ifsc: string; net_paise: number }>()
    let b = 'Beneficiary Name,Account Number,IFSC,Amount,Narration\n'
    let missing = 0
    const csvSafe = (s: string) => s.replace(/[,\n\r]/g, ' ')
    for (const v of rows.results) {
      if (v.acct === '' || v.ifsc === '') missing++
      b += `${csvSafe(v.name)},${v.acct},${v.ifsc},${(v.net_paise / 100).toFixed(2)},Salary ${pad2(month)}/${year}\n`
    }
    await c.db.prepare(`UPDATE payroll_runs SET bank_file_drawn_at = COALESCE(bank_file_drawn_at, ?) WHERE period_year = ? AND period_month = ?`)
      .bind(now(), year, month).run()
    return new Response(b, { headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="salary-${year}-${pad2(month)}.csv"`,
      'x-missing-bank-details': String(missing),
    } })
  })

  r.get('/payroll/ctc', PAYROLL_READ, async (c) => {
    const employee = c.url.searchParams.get('employee_id') ?? ''
    if (!isUUID(employee)) throw badRequest('employee_id must be a uuid')
    const set = await loadPayrollSettings(c)
    const emp = await c.db.prepare(`SELECT ${EMP_NAME} AS name FROM employees e WHERE e.id = ?`).bind(employee).first<{ name: string }>()
    if (!emp) throw notFound('resource not found')
    const today = todayIST()
    const rows = await c.db.prepare(`SELECT sc.code, sc.name, sc.kind, ssi.amount_paise FROM salary_structures ss
        JOIN salary_structure_items ssi ON ssi.salary_structure_id = ss.id JOIN salary_components sc ON sc.id = ssi.component_id
       WHERE ss.employee_id = ? AND ss.effective_from <= ? AND (ss.effective_to IS NULL OR ss.effective_to >= ?) ORDER BY sc.sequence`)
      .bind(employee, today, today).all<{ code: string; name: string; kind: string; amount_paise: number }>()
    const earnings: { code: string; name: string; amount_paise: number }[] = []
    let grossMonthly = 0, basicDA = 0
    for (const v of rows.results) {
      if (v.kind !== 'earning') continue
      earnings.push({ code: v.code, name: v.name, amount_paise: v.amount_paise })
      grossMonthly += v.amount_paise
      if (v.code === 'BASIC' || v.code === 'DA') basicDA += v.amount_paise
    }
    const st = computeStatutory(set, basicDA, grossMonthly, nowIST().getUTCMonth() + 1)
    const deductions = st.pf_employee_paise + st.esi_employee_paise + st.pt_paise
    const employerCost = st.pf_employer_paise + st.eps_paise + st.pf_admin_paise + st.esi_employer_paise
    const ctcMonthly = grossMonthly + employerCost
    return ok({
      employee_id: employee, full_name: emp.name, earnings, gross_monthly_paise: grossMonthly, statutory: st,
      employee_deductions_paise: deductions, net_monthly_paise: grossMonthly - deductions, employer_cost_paise: employerCost,
      ctc_monthly_paise: ctcMonthly, ctc_annual_paise: ctcMonthly * 12,
      gratuity_accrual_annual_paise: set.gratuity_month_days > 0 ? Math.trunc((basicDA * set.gratuity_days) / set.gratuity_month_days) : 0,
    })
  })

  r.get('/payroll/gratuity', PAYROLL_READ, async (c) => {
    const set = await loadPayrollSettings(c)
    const today = todayIST()
    const rows = await c.db.prepare(`
      SELECT e.id AS employee_id, ${EMP_NAME} AS name, ${dateOf('e.joined_on')} AS joined_on,
             (julianday(?1) - julianday(e.joined_on)) / 365.25 AS years,
             COALESCE((SELECT SUM(ssi.amount_paise) FROM salary_structures ss JOIN salary_structure_items ssi ON ssi.salary_structure_id = ss.id
                         JOIN salary_components sc ON sc.id = ssi.component_id
                        WHERE ss.employee_id = e.id AND sc.code IN ('BASIC','DA') AND ss.effective_from <= ?1 AND (ss.effective_to IS NULL OR ss.effective_to >= ?1)), 0) AS basic_da
        FROM employees e WHERE e.status = 'active' AND e.joined_on IS NOT NULL ORDER BY e.joined_on`).bind(today).all()
    let total = 0, vestedTotal = 0, unknown = 0
    const out = rows.results.map((v) => {
      const years = numOr0(v.years)
      let counted = Math.trunc(years)
      if (years - counted > 0.5) counted++
      const basicDA = numOr0(v.basic_da)
      const eligible = years >= set.gratuity_min_years
      let accrued = 0
      if (set.gratuity_month_days > 0) {
        accrued = Math.trunc((basicDA * set.gratuity_days * counted) / set.gratuity_month_days)
        if (set.gratuity_cap_paise > 0 && accrued > set.gratuity_cap_paise) accrued = set.gratuity_cap_paise
      }
      const vested = eligible ? accrued : 0
      total += accrued; vestedTotal += vested
      if (basicDA === 0) unknown++
      return {
        employee_id: v.employee_id, full_name: v.name, joined_on: v.joined_on, years_of_service: years, counted_years: counted,
        basic_da_paise: basicDA, accrued_paise: accrued, vested_paise: vested, eligible, no_salary_structure: basicDA === 0,
      }
    })
    return ok({ items: out, total_accrued_paise: total, vested_paise: vestedTotal, staff_without_salary_structure: unknown })
  })

  r.get('/payroll/tax', PAYROLL_READ, getTaxComputation)
  r.get('/payroll/declarations', PAYROLL_READ, async (c) => {
    const fy = fyFrom(c)
    const emp = c.url.searchParams.get('employee_id') || null
    const rows = await c.db.prepare(`
      SELECT d.id, d.employee_id, ${EMP_NAME} AS full_name, d.section, d.particulars, d.declared_paise, d.verified_paise, d.status, d.remarks,
             CASE WHEN d.status = 'rejected' THEN 0 ELSE COALESCE(d.verified_paise, d.declared_paise) END AS counted
        FROM investment_declarations d JOIN employees e ON e.id = d.employee_id
       WHERE d.fy_start_year = ? AND (? IS NULL OR d.employee_id = ?) ORDER BY e.first_name, d.section`).bind(fy, emp, emp).all()
    return ok(items(rows.results.map(declarationRow)))
  })
  r.post('/payroll/declarations', PAYROLL_WRITE, saveDeclaration)

  r.get('/payroll/loans', PAYROLL_READ, async (c) => {
    const status = c.url.searchParams.get('status') || null
    const rows = await c.db.prepare(`
      SELECT l.id, l.employee_id, ${EMP_NAME} AS full_name, l.kind, l.principal_paise, l.instalment_paise, l.start_year, l.start_month, l.reason, l.status,
             COALESCE(d.taken, 0) AS recovered, MAX(0, l.principal_paise - COALESCE(d.taken, 0)) AS outstanding,
             CASE WHEN l.instalment_paise > 0 THEN CAST(CEIL(MAX(0, l.principal_paise - COALESCE(d.taken,0)) * 1.0 / l.instalment_paise) AS INTEGER) ELSE 0 END AS months_left
        FROM staff_loans l JOIN employees e ON e.id = l.employee_id
        LEFT JOIN (SELECT ld.loan_id, SUM(ld.amount_paise) AS taken FROM loan_deductions ld GROUP BY ld.loan_id) d ON d.loan_id = l.id
       WHERE (? IS NULL OR l.status = ?) ORDER BY (l.status = 'active') DESC, e.first_name`).bind(status, status).all()
    return ok(items(rows.results.map((v) => ({
      id: v.id, employee_id: v.employee_id, full_name: v.full_name, kind: v.kind, principal_paise: numOr0(v.principal_paise),
      instalment_paise: numOr0(v.instalment_paise), start_year: numOr0(v.start_year), start_month: numOr0(v.start_month),
      reason: v.reason ?? undefined, status: v.status, recovered_paise: numOr0(v.recovered), outstanding_paise: numOr0(v.outstanding),
      months_left: numOr0(v.months_left),
    }))))
  })
  r.post('/payroll/loans', PAYROLL_WRITE, async (c) => {
    const req = await readJSON<{ id?: string; employee_id?: string; kind?: string; principal_paise?: number; instalment_paise?: number
      start_year?: number; start_month?: number; reason?: string; status?: string }>(c.req)
    if (req.id) {
      if (!isUUID(req.id)) throw badRequest('id must be a uuid')
      const status = req.status ?? ''
      await c.db.prepare(`UPDATE staff_loans SET status = COALESCE(NULLIF(?2,''), status),
          closed_on = CASE WHEN ?2 IN ('closed','cancelled') THEN ?3 ELSE closed_on END WHERE id = ?1`).bind(req.id, status, todayIST()).run()
      return ok({ id: req.id })
    }
    const employee = req.employee_id ?? ''
    if (!isUUID(employee)) throw badRequest('employee_id must be a uuid')
    const principal = numOr0(req.principal_paise), instalment = numOr0(req.instalment_paise)
    if (principal <= 0 || instalment <= 0) throw badRequest('an advance needs an amount and an instalment')
    if (instalment > principal) throw badRequest('the instalment cannot be larger than the advance itself')
    const kind = req.kind || 'advance'
    let startYear = numOr0(req.start_year), startMonth = numOr0(req.start_month)
    if (startYear === 0) { const n = nowIST(); startYear = n.getUTCFullYear(); startMonth = n.getUTCMonth() + 1 }
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO staff_loans (id, institution_id, employee_id, kind, principal_paise, instalment_paise, start_year, start_month, reason, approved_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?,''), ?, ?)`)
        .bind(id, c.id.institution!.id, employee, kind, principal, instalment, startYear, startMonth, req.reason ?? '', c.id.userId, now()).run()
    } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return created({ id })
  })

  r.get('/payroll/contractor-bills', PAYROLL_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT id, vendor, service, period_year, period_month, invoice_no, claimed_days, verified_days, rate_paise, claimed_paise, approved_paise, status, remarks,
             MAX(0, claimed_paise - COALESCE(approved_paise, claimed_paise)) AS shortfall
        FROM contractor_bills ORDER BY period_year DESC, period_month DESC, vendor LIMIT 200`).all()
    return ok(items(rows.results.map((v) => ({
      id: v.id, vendor: v.vendor, service: v.service, period_year: numOr0(v.period_year), period_month: numOr0(v.period_month),
      invoice_no: v.invoice_no ?? undefined, claimed_days: numOr0(v.claimed_days), verified_days: num(v.verified_days) ?? undefined,
      rate_paise: numOr0(v.rate_paise), claimed_paise: numOr0(v.claimed_paise), approved_paise: num(v.approved_paise) ?? undefined,
      status: v.status, remarks: v.remarks ?? undefined, shortfall_paise: numOr0(v.shortfall),
    }))))
  })
  r.post('/payroll/contractor-bills', PAYROLL_WRITE, async (c) => {
    const req = await readJSON<{ id?: string; vendor?: string; service?: string; period_year?: number; period_month?: number; invoice_no?: string
      claimed_days?: number; verified_days?: number | null; rate_paise?: number; status?: string; remarks?: string }>(c.req)
    if (req.id) {
      if (req.verified_days == null) throw badRequest('verifying a bill means saying how many days were actually worked')
      if (!isUUID(req.id)) throw badRequest('id must be a uuid')
      const status = req.status || 'verified'
      const remarks = (req.remarks ?? '').trim()
      // contractor_bills_shortfall_explained: approving less than billed needs a reason on the record.
      const bill = await c.db.prepare(`SELECT claimed_paise, rate_paise FROM contractor_bills WHERE id = ?`).bind(req.id).first<{ claimed_paise: number; rate_paise: number }>()
      if (bill && req.verified_days * bill.rate_paise < bill.claimed_paise && remarks === '') {
        throw badRequest('approving less than the vendor billed needs a reason on the record')
      }
      await c.db.prepare(`UPDATE contractor_bills SET verified_days = ?2, approved_paise = ?2 * rate_paise, status = ?3, remarks = NULLIF(?4,''), verified_by = ?5 WHERE id = ?1`)
        .bind(req.id, req.verified_days, status, remarks, c.id.userId).run()
      return ok({ id: req.id })
    }
    const vendor = (req.vendor ?? '').trim(), claimedDays = numOr0(req.claimed_days), rate = numOr0(req.rate_paise)
    if (vendor === '' || claimedDays <= 0 || rate <= 0) throw badRequest('a bill needs a vendor, the days claimed and a day rate')
    const service = req.service || 'security'
    let year = numOr0(req.period_year), month = numOr0(req.period_month)
    if (year === 0) [year, month] = periodFrom(c)
    const dup = await c.db.prepare(`SELECT 1 FROM contractor_bills WHERE institution_id = ? AND vendor = ? AND service = ? AND period_year = ? AND period_month = ?`)
      .bind(c.id.institution!.id, req.vendor, service, year, month).first()
    if (dup) throw coded(409, 'already_billed', 'that vendor has already billed for this service this month')
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO contractor_bills (id, institution_id, vendor, service, period_year, period_month, invoice_no, claimed_days, rate_paise, claimed_paise, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULLIF(?,''), ?, ?, ?, ?)`)
        .bind(id, c.id.institution!.id, req.vendor, service, year, month, req.invoice_no ?? '', claimedDays, rate, claimedDays * rate, now()).run()
    } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return created({ id })
  })
}

// ------------------------------------------------------------ income tax

interface TaxSlab { upTo: number; percent: number }
const newRegimeSlabs: TaxSlab[] = [
  { upTo: 30000000, percent: 0 }, { upTo: 70000000, percent: 5 }, { upTo: 100000000, percent: 10 },
  { upTo: 120000000, percent: 15 }, { upTo: 150000000, percent: 20 }, { upTo: 0, percent: 30 },
]
const oldRegimeSlabs: TaxSlab[] = [
  { upTo: 25000000, percent: 0 }, { upTo: 50000000, percent: 5 }, { upTo: 100000000, percent: 20 }, { upTo: 0, percent: 30 },
]
const stdDeductionNew = 7500000, stdDeductionOld = 5000000
const rebateLimitNew = 70000000, rebateLimitOld = 50000000, rebateCapNew = 2500000, rebateCapOld = 1250000
const cessPercent = 4, section80CCap = 15000000

function slabTax(income: number, slabs: TaxSlab[]): number {
  let tax = 0, floor = 0
  for (const sl of slabs) {
    if (income <= floor) break
    let top = sl.upTo
    if (top === 0 || income < top) top = income
    tax += pct(top - floor, sl.percent)
    floor = sl.upTo
    if (sl.upTo === 0) break
  }
  return tax
}

function declarationRow(v: Record<string, unknown>) {
  return {
    id: v.id, employee_id: v.employee_id || undefined, full_name: v.full_name || undefined, section: v.section, particulars: v.particulars,
    declared_paise: numOr0(v.declared_paise), verified_paise: num(v.verified_paise) ?? undefined, status: v.status,
    remarks: v.remarks ?? undefined, counted_paise: numOr0(v.counted),
  }
}

async function getTaxComputation(c: Ctx) {
  const fy = fyFrom(c)
  const employee = c.url.searchParams.get('employee_id') ?? ''
  if (employee === '') {
    const rows = await c.db.prepare(`
      SELECT e.id AS employee_id, ${EMP_NAME} AS full_name, e.pan, COALESCE(el.regime, 'new') AS regime, el.elected_on IS NOT NULL AS elected,
             COALESCE(paid.gross, 0) AS gross_paid_paise, COALESCE(paid.months, 0) AS months_paid,
             COALESCE(d.n, 0) AS declarations, COALESCE(d.declared, 0) AS declared_paise, COALESCE(d.unverified, 0) AS unverified_proofs
        FROM employees e
        LEFT JOIN employee_tax_elections el ON el.employee_id = e.id AND el.fy_start_year = ?1
        LEFT JOIN (SELECT ps.employee_id, SUM(ps.gross_paise) AS gross, COUNT(*) AS months FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
                    WHERE (pr.period_year * 100 + pr.period_month) BETWEEN ?1 * 100 + 4 AND (?1 + 1) * 100 + 3 GROUP BY ps.employee_id) paid ON paid.employee_id = e.id
        LEFT JOIN (SELECT idl.employee_id, COUNT(*) AS n,
                          SUM(CASE WHEN status = 'rejected' THEN 0 ELSE COALESCE(verified_paise, declared_paise) END) AS declared,
                          SUM(CASE WHEN status IN ('declared','proof_submitted') THEN 1 ELSE 0 END) AS unverified
                     FROM investment_declarations idl WHERE idl.fy_start_year = ?1 GROUP BY idl.employee_id) d ON d.employee_id = e.id
       WHERE e.status = 'active' ORDER BY e.first_name`).bind(fy).all()
    return ok(items(rows.results.map((v) => ({
      employee_id: v.employee_id, full_name: v.full_name, pan: v.pan ?? undefined, regime: v.regime, elected: bool(v.elected),
      gross_paid_paise: numOr0(v.gross_paid_paise), months_paid: numOr0(v.months_paid), declarations: numOr0(v.declarations),
      declared_paise: numOr0(v.declared_paise), unverified_proofs: numOr0(v.unverified_proofs),
    }))))
  }
  if (!isUUID(employee)) throw badRequest('employee_id must be a uuid')
  const emp = await c.db.prepare(`SELECT ${EMP_NAME} AS name, e.pan FROM employees e WHERE e.id = ?`).bind(employee).first<{ name: string; pan: string | null }>()
  if (!emp) throw notFound('resource not found')
  const el = await c.db.prepare(`SELECT regime, elected_on FROM employee_tax_elections WHERE employee_id = ? AND fy_start_year = ?`).bind(employee, fy)
    .first<{ regime: string; elected_on: string | null }>()
  const regime = el?.regime ?? 'new'
  const paid = await c.db.prepare(`
    SELECT COALESCE(SUM(ps.gross_paise), 0) AS gross, COALESCE(SUM(COALESCE(json_extract(ps.breakup, '$.PT'), 0)), 0) * -1 AS pt, COUNT(*) AS n
      FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
     WHERE ps.employee_id = ?1 AND (pr.period_year * 100 + pr.period_month) BETWEEN ?2 * 100 + 4 AND (?2 + 1) * 100 + 3`).bind(employee, fy)
    .first<{ gross: number; pt: number; n: number }>()
  let grossAnnual = numOr0(paid?.gross), profTax = numOr0(paid?.pt)
  const monthsPaid = numOr0(paid?.n)
  let projected = false
  if (monthsPaid > 0 && monthsPaid < 12) {
    grossAnnual = Math.trunc(grossAnnual / monthsPaid) * 12
    profTax = Math.trunc(profTax / monthsPaid) * 12
    projected = true
  }
  const decls = await c.db.prepare(`SELECT id, section, particulars, declared_paise, verified_paise, status FROM investment_declarations
      WHERE employee_id = ? AND fy_start_year = ? ORDER BY section, particulars`).bind(employee, fy).all<Record<string, unknown>>()
  let c80 = 0, other = 0
  const declarations = decls.results.map((d) => {
    const status = str(d.status), verified = num(d.verified_paise), declared = numOr0(d.declared_paise)
    const counted = status === 'rejected' ? 0 : verified !== null ? verified : declared
    if (str(d.section).startsWith('80C')) c80 += counted; else other += counted
    return { id: d.id, section: d.section, particulars: d.particulars, declared_paise: declared, verified_paise: verified ?? undefined, status, counted_paise: counted }
  })
  if (c80 > section80CCap) c80 = section80CCap
  const chapter6A = c80 + other
  let slabs = newRegimeSlabs, standardDed = stdDeductionNew, rebateLimit = rebateLimitNew, rebateCap = rebateCapNew
  let deductions = standardDed
  if (regime === 'old') {
    slabs = oldRegimeSlabs; standardDed = stdDeductionOld; rebateLimit = rebateLimitOld; rebateCap = rebateCapOld
    deductions = standardDed + chapter6A + profTax
  }
  const taxable = Math.max(0, grossAnnual - deductions)
  const taxBefore = slabTax(taxable, slabs)
  let rebate = 0
  if (taxable <= rebateLimit) rebate = Math.min(taxBefore, rebateCap)
  const afterRebate = Math.max(0, taxBefore - rebate)
  const cess = pct(afterRebate, cessPercent)
  const taxPayable = afterRebate + cess
  const remaining = Math.max(1, 12 - monthsPaid)
  return ok({
    employee_id: employee, full_name: emp.name, pan: emp.pan ?? undefined, fy_start_year: fy, regime, elected: !!el?.elected_on,
    gross_annual_paise: grossAnnual, months_paid: monthsPaid, projected, standard_deduction_paise: standardDed, chapter_via_paise: chapter6A,
    professional_tax_paise: profTax, taxable_income_paise: taxable, tax_before_rebate_paise: taxBefore, rebate_paise: rebate, cess_paise: cess,
    tax_payable_paise: taxPayable, monthly_tds_paise: Math.trunc(taxPayable / remaining), declarations,
  })
}

async function saveDeclaration(c: Ctx) {
  const req = await readJSON<{ id?: string; employee_id?: string; fy_start_year?: number; section?: string; particulars?: string; declared_paise?: number
    verified_paise?: number | null; status?: string; remarks?: string; regime?: string }>(c.req)
  const fy = numOr0(req.fy_start_year) || currentFY()
  if (req.id) {
    if (req.status === 'rejected' && (req.remarks ?? '').trim() === '') throw badRequest('say why it was rejected. An employee cannot fix a proof nobody explained')
    if (req.status === 'verified' && req.verified_paise == null) throw badRequest('verifying needs the amount actually accepted')
    if (!isUUID(req.id)) throw badRequest('id must be a uuid')
    await c.db.prepare(`UPDATE investment_declarations SET status = COALESCE(NULLIF(?2,''), status), verified_paise = COALESCE(?3, verified_paise),
        remarks = COALESCE(NULLIF(?4,''), remarks), updated_at = ?5 WHERE id = ?1`)
      .bind(req.id, req.status ?? '', req.verified_paise ?? null, req.remarks ?? '', now()).run()
    return ok({ id: req.id })
  }
  const employee = req.employee_id ?? ''
  if (!isUUID(employee)) throw badRequest('employee_id must be a uuid')
  if ((req.section ?? '').trim() === '' || (req.particulars ?? '').trim() === '') throw badRequest('a declaration needs a section and what was invested in')
  const inst = c.id.institution!.id
  const stmts: D1PreparedStatement[] = []
  if (req.regime) {
    const ex = await c.db.prepare(`SELECT id FROM employee_tax_elections WHERE employee_id = ? AND fy_start_year = ?`).bind(employee, fy).first<{ id: string }>()
    if (ex) stmts.push(c.db.prepare(`UPDATE employee_tax_elections SET regime = ?, elected_on = ? WHERE id = ?`).bind(req.regime, todayIST(), ex.id))
    else stmts.push(c.db.prepare(`INSERT INTO employee_tax_elections (id, institution_id, employee_id, fy_start_year, regime, elected_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst, employee, fy, req.regime, todayIST(), now()))
  }
  const id = uuid()
  stmts.push(c.db.prepare(`INSERT INTO investment_declarations (id, institution_id, employee_id, fy_start_year, section, particulars, declared_paise, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?)`).bind(id, inst, employee, fy, req.section, req.particulars, numOr0(req.declared_paise), now(), now()))
  try { await c.db.batch(stmts) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
  return created({ id })
}
