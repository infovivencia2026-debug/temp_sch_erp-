import type { Router } from '../../router'
import { badRequest, bool, clampInt, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { addDays, fullName, isHHMM, isUUIDish, istClock, istMinute, nextNumber, nz, parseJSON, round1, str, todayIST } from '../admissions/util'
import { employeeFilter, growthReach } from './reach'
import { school } from '../school'

/* Port of the /hr group's own handlers: the dashboard, the employee directory
   (role_backoffice.go), one member of staff (staff_detail.go), the workload
   and results page (staff_overview.go), letters (staff_letters.go), the ID
   card artwork (id_card_template.go), leave types (leave_types.go), the
   leave list registered outside the group, and the punch grace window. */

const READ = 'hr.employees.read', WRITE = 'hr.employees.write'
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

// --- keyset cursors (students.go) --------------------------------------------------

interface ListCursor { a: string; i: string; f: string }
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function encodeCursor(c: ListCursor): string { return b64url(new TextEncoder().encode(JSON.stringify(c))) }
function decodeCursor(raw: string, filter: string): ListCursor | null {
  if (raw === '') return null
  try {
    const s = atob(raw.replace(/-/g, '+').replace(/_/g, '/'))
    const c = JSON.parse(s) as ListCursor
    if (!c.i || c.f !== filter || !isUUID(c.i)) return null
    return c
  } catch { return null }
}
async function filterFingerprint(...parts: string[]): Promise<string> {
  const sum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\x1f')))
  return b64url(new Uint8Array(sum).slice(0, 9))
}

// --- the staff overview (staff_overview.go) ------------------------------------------

interface StaffOverview {
  staff: { id: string; name: string; designation: string }
  load: { subjects_count: number; sections_count: number; students_count: number; periods_per_week: number
    class_teacher_of: { class: string; section: string }[]; subjects: { class: string; section: string; subject: string; students: number }[] }
  marks: { has_marks: boolean; overall_avg_pct: number; pass_rate_pct: number; distinction_rate_pct: number
    by_subject: { subject: string; avg_pct: number; students: number; exams: number }[]
    trend: { exam: string; date: string; avg_pct: number }[]
    by_section: { class: string; section: string; avg_pct: number }[] }
}

async function computeStaffOverview(db: D1Database, staffID: string, userID: string | null, name: string, designation: string): Promise<StaffOverview> {
  const ov: StaffOverview = {
    staff: { id: staffID, name, designation },
    load: { subjects_count: 0, sections_count: 0, students_count: 0, periods_per_week: 0, class_teacher_of: [], subjects: [] },
    marks: { has_marks: false, overall_avg_pct: 0, pass_rate_pct: 0, distinction_rate_pct: 0, by_subject: [], trend: [], by_section: [] },
  }
  if (!userID) return ov
  const subjects = await db.prepare(`
    SELECT c.name AS class, sec.name AS section, sub.name AS subject,
           (SELECT count(*) FROM enrollments en WHERE en.section_id = sec.id AND en.status = 'active') AS students
      FROM section_subject_teachers sst JOIN sections sec ON sec.id = sst.section_id JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
     WHERE sst.teacher_user_id = ? ORDER BY c.name, sec.name, sub.name`).bind(userID).all<{ class: string; section: string; subject: string; students: number }>()
  const subjectSet = new Set<string>(), sectionSet = new Set<string>()
  for (const s of subjects.results) { ov.load.subjects.push(s); subjectSet.add(s.subject); sectionSet.add(s.class + '|' + s.section) }
  ov.load.subjects_count = subjectSet.size
  ov.load.sections_count = sectionSet.size
  ov.load.students_count = (await db.prepare(`SELECT count(DISTINCT en.student_id) AS n FROM section_subject_teachers sst JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active' WHERE sst.teacher_user_id = ?`).bind(userID).first<{ n: number }>())?.n ?? 0
  ov.load.periods_per_week = (await db.prepare(`SELECT count(*) AS n FROM timetable_entries WHERE teacher_user_id = ?`).bind(userID).first<{ n: number }>())?.n ?? 0
  const ct = await db.prepare(`SELECT c.name AS class, sec.name AS section FROM sections sec JOIN classes c ON c.id = sec.class_id WHERE sec.class_teacher_id = ? ORDER BY c.name, sec.name`).bind(userID).all<{ class: string; section: string }>()
  ov.load.class_teacher_of = ct.results

  const mr = await db.prepare(`
    SELECT sub.name AS subject, c.name AS class, sec.name AS section, ex.id AS exam_id, ex.name AS exam_name, COALESCE(es.exam_date, '') AS exam_date, m.student_id AS student,
           CAST(m.marks_obtained AS REAL) / NULLIF(CAST(es.max_marks AS REAL), 0) * 100 AS pct,
           (CAST(m.marks_obtained AS REAL) >= COALESCE(CAST(es.pass_marks AS REAL), CAST(es.max_marks AS REAL) * 0.33)) AS passed
      FROM section_subject_teachers sst
      JOIN exam_subjects es ON es.class_subject_id = sst.class_subject_id
      JOIN exams ex ON ex.id = es.exam_id AND ex.is_published = 1
      JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      JOIN sections sec ON sec.id = sst.section_id JOIN classes c ON c.id = sec.class_id
      JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active'
      JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = en.student_id
     WHERE sst.teacher_user_id = ? AND m.is_absent = 0`).bind(userID)
    .all<{ subject: string; class: string; section: string; exam_id: string; exam_name: string; exam_date: string; student: string; pct: number | null; passed: number }>()
  const rows = mr.results.filter((r) => r.pct !== null).map((r) => ({ ...r, pct: r.pct as number, distinction: (r.pct as number) >= 75 }))
  if (rows.length === 0) return ov
  ov.marks.has_marks = true
  const n = rows.length
  ov.marks.overall_avg_pct = round1(rows.reduce((s, r) => s + r.pct, 0) / n)
  ov.marks.pass_rate_pct = round1(rows.filter((r) => bool(r.passed)).length / n * 100)
  ov.marks.distinction_rate_pct = round1(rows.filter((r) => r.distinction).length / n * 100)
  const subj = new Map<string, { sum: number; count: number; students: Set<string>; exams: Set<string> }>()
  for (const r of rows) {
    let a = subj.get(r.subject)
    if (!a) { a = { sum: 0, count: 0, students: new Set(), exams: new Set() }; subj.set(r.subject, a) }
    a.sum += r.pct; a.count++; a.students.add(r.student); a.exams.add(r.exam_id)
  }
  for (const name of [...subj.keys()].sort()) {
    const a = subj.get(name)!
    ov.marks.by_subject.push({ subject: name, avg_pct: round1(a.sum / a.count), students: a.students.size, exams: a.exams.size })
  }
  const trend = new Map<string, { name: string; date: string; sum: number; count: number }>()
  for (const r of rows) {
    let a = trend.get(r.exam_id)
    if (!a) { a = { name: r.exam_name, date: r.exam_date, sum: 0, count: 0 }; trend.set(r.exam_id, a) }
    a.sum += r.pct; a.count++
  }
  const trendVals = [...trend.values()].sort((a, b) => {
    if (a.date === b.date) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    if (a.date === '') return 1
    if (b.date === '') return -1
    return a.date < b.date ? -1 : 1
  })
  for (const a of trendVals) ov.marks.trend.push({ exam: a.name, date: a.date, avg_pct: round1(a.sum / a.count) })
  const secs = new Map<string, { class: string; section: string; sum: number; count: number }>()
  for (const r of rows) {
    const key = r.class + '|' + r.section
    let a = secs.get(key)
    if (!a) { a = { class: r.class, section: r.section, sum: 0, count: 0 }; secs.set(key, a) }
    a.sum += r.pct; a.count++
  }
  for (const key of [...secs.keys()].sort()) {
    const a = secs.get(key)!
    ov.marks.by_section.push({ class: a.class, section: a.section, avg_pct: round1(a.sum / a.count) })
  }
  return ov
}

async function resolveStaffOverview(db: D1Database, eid: string): Promise<StaffOverview | null> {
  const e = await db.prepare(`SELECT e.user_id, ${fullName('e.first_name', 'e.last_name')} AS name, COALESCE(dg.name, '') AS designation
      FROM employees e LEFT JOIN designations dg ON dg.id = e.designation_id WHERE e.id = ?`).bind(eid).first<{ user_id: string | null; name: string; designation: string }>()
  if (!e) return null
  return computeStaffOverview(db, eid, e.user_id, e.name, e.designation)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;')
const clampPct = (p: number) => Math.max(0, Math.min(100, p))
const staffReportTitle = (ov: StaffOverview) => (ov.staff.designation !== '' ? `${ov.staff.name} · ${ov.staff.designation}` : ov.staff.name)

function svgBarChart(bars: { label: string; value: number }[]): string {
  if (bars.length === 0) return `<p class="empty">No data.</p>`
  const bw = 46, gap = 14, base = 150, top = 12
  const w = gap + bars.length * (bw + gap)
  let ch = `<svg viewBox="0 0 ${w} 180" width="100%" style="max-width:${w}px" font-family="sans-serif">`
  ch += `<line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="#ccc"/>`
  bars.forEach((bar, i) => {
    const pct = clampPct(bar.value)
    const bh = Math.trunc(pct / 100 * (base - top)) + 2
    const x = gap + i * (bw + gap), y = base - bh
    const fill = pct >= 75 ? '#3f6bbf' : pct < 33 ? '#c76b6b' : '#6b8fd4'
    ch += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${fill}"/>`
    ch += `<text x="${x + Math.trunc(bw / 2)}" y="${y - 3}" text-anchor="middle" font-size="9">${pct.toFixed(0)}</text>`
    ch += `<text x="${x + Math.trunc(bw / 2)}" y="168" text-anchor="middle" font-size="8">${esc(bar.label.slice(0, 6))}</text>`
  })
  return ch + `</svg>`
}

function svgTrendChart(pts: { label: string; value: number }[]): string {
  if (pts.length === 0) return `<p class="empty">No data.</p>`
  const step = 70, base = 150, top = 12, left = 30
  const w = left + pts.length * step
  const px = (i: number) => Math.trunc(left / 2) + i * step + Math.trunc(step / 2)
  const py = (v: number) => base - Math.trunc(clampPct(v) / 100 * (base - top))
  let ch = `<svg viewBox="0 0 ${w} 180" width="100%" style="max-width:${w}px" font-family="sans-serif">`
  ch += `<line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="#ccc"/>`
  ch += `<polyline fill="none" stroke="#3f6bbf" stroke-width="2" points="${pts.map((p, i) => `${px(i)},${py(p.value)}`).join(' ')}"/>`
  pts.forEach((p, i) => {
    const cx = px(i), cy = py(p.value)
    ch += `<circle cx="${cx}" cy="${cy}" r="3" fill="#3f6bbf"/>`
    ch += `<text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="9">${clampPct(p.value).toFixed(0)}</text>`
    ch += `<text x="${cx}" y="168" text-anchor="middle" font-size="8">${esc(p.label.slice(0, 8))}</text>`
  })
  return ch + `</svg>`
}

function staffOverviewSection(ov: StaffOverview): string {
  const stat = (label: string, val: string | number) => `<div class="stat"><div class="num">${val}</div><div class="lbl">${esc(label)}</div></div>`
  let b = `<div class="stats">`
  b += stat('Subjects', ov.load.subjects_count) + stat('Sections', ov.load.sections_count) + stat('Students', ov.load.students_count) + stat('Periods/week', ov.load.periods_per_week)
  if (ov.marks.has_marks) {
    b += stat('Avg %', ov.marks.overall_avg_pct.toFixed(1)) + stat('Pass %', ov.marks.pass_rate_pct.toFixed(1)) + stat('Distinction %', ov.marks.distinction_rate_pct.toFixed(1))
  }
  b += `</div>`
  if (ov.load.class_teacher_of.length > 0) b += `<p class="ct">Class teacher of: ${ov.load.class_teacher_of.map((ct) => esc(ct.class + ' ' + ct.section)).join(', ')}</p>`
  if (!ov.marks.has_marks) return b + `<p class="empty">No published marks for this teacher's classes yet.</p>`
  b += `<h2>Average % by subject</h2>` + svgBarChart(ov.marks.by_subject.map((s) => ({ label: s.subject, value: s.avg_pct })))
  b += `<h2>Trend across exams</h2>` + svgTrendChart(ov.marks.trend.map((t) => ({ label: t.date !== '' ? t.date : t.exam, value: t.avg_pct })))
  return b
}

const staffOverviewCSS = `
body { font-family: sans-serif; color: #222; margin: 0; }
.report { padding: 24px; }
.report h1 { font-size: 20px; margin: 0 0 12px; }
.report h2 { font-size: 14px; margin: 18px 0 6px; color: #3f6bbf; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.stat { border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 14px; min-width: 90px; }
.stat .num { font-size: 20px; font-weight: 700; }
.stat .lbl { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
.ct { font-size: 12px; color: #444; margin: 4px 0 10px; }
.empty { font-style: italic; color: #888; }
.page-break { page-break-before: always; }
.page-break:first-child { page-break-before: avoid; }
@media print {
  body { margin: 0; }
  .report { padding: 12mm; }
  .page-break { page-break-before: always; }
  .stat { border: 1px solid #ccc; }
}
`

// --- letters (staff_letters.go, issueStaffCertificate in hr_lifecycle.go) -------------

const staffLetterKinds: Record<string, string> = { APPOINTMENT: 'Appointment Letter', SALARY_REVISION: 'Salary Revision Letter', WARNING: 'Warning Letter', SERVICE: 'Service Certificate' }
function staffCertificateName(code: string): string {
  if (code === 'RELIEVING') return 'Relieving Letter'
  if (code === 'EXPERIENCE') return 'Experience Certificate'
  return staffLetterKinds[code] ?? code
}

/** Writes one relieving, experience or service certificate against issued_certificates; returns the serial and the statements to batch. */
export async function issueStaffCertificate(db: D1Database, inst: string, actor: string, emp: string, code: string, remarks: string | null): Promise<{ serial: string; stmts: D1PreparedStatement[] }> {
  const stmts: D1PreparedStatement[] = []
  let typeID = (await db.prepare(`SELECT id FROM certificate_types WHERE code = ?`).bind(code).first<{ id: string }>())?.id
  if (!typeID) {
    typeID = uuid()
    stmts.push(db.prepare(`INSERT INTO certificate_types (id, institution_id, code, name, requires_approval, updated_at) VALUES (?,?,?,?,0,?)`).bind(typeID, inst, code, staffCertificateName(code), now()))
  }
  const serial = await nextNumber(db, inst, 'certificate')
  const e = await db.prepare(`SELECT ${fullName('e.first_name', 'e.last_name')} AS name, e.employee_code, d.name AS designation, dep.name AS department, e.joined_on, e.relieved_on
      FROM employees e LEFT JOIN designations d ON d.id = e.designation_id LEFT JOIN departments dep ON dep.id = e.department_id WHERE e.id = ?`).bind(emp)
    .first<{ name: string; employee_code: string; designation: string | null; department: string | null; joined_on: string; relieved_on: string | null }>()
  if (!e) throw badRequest('That member of staff is not on this school\'s roll.')
  const quals = await db.prepare(`SELECT qualification FROM staff_qualifications WHERE employee_id = ? ORDER BY year_of_passing`).bind(emp).all<{ qualification: string }>()
  const today = todayIST()
  const relieved = e.relieved_on ?? today
  const years = Math.max(0, Math.floor((Date.parse(relieved) - Date.parse(e.joined_on)) / (365.25 * 86_400_000)))
  const snapshot = { name: e.name, employee_code: e.employee_code, designation: e.designation, department: e.department, joined_on: e.joined_on, relieved_on: relieved,
    years_of_service: years, qualifications: quals.results.map((q) => q.qualification), conduct: 'satisfactory', remarks, issued_at: now() }
  stmts.push(db.prepare(`INSERT INTO issued_certificates (id, institution_id, certificate_type_id, employee_id, serial_no, issued_on, snapshot, status, requested_by, created_at) VALUES (?,?,?,?,?,?,?,'issued',?,?)`)
    .bind(uuid(), inst, typeID, emp, serial, today, JSON.stringify(snapshot), actor, now()))
  return { serial, stmts }
}

// --- leave (role_backoffice.go) ------------------------------------------------------------

function leaveFor(q: URLSearchParams): string | null {
  switch (q.get('for')) {
    case 'staff': case 'employee': return 'staff'
    case 'student': case 'students': return 'student'
  }
  return null
}

export function registerStaff(r: Router) {
  /* Registered outside the /hr guard: anyone may read their own leave; the HR grant widens it. */
  r.get('/hr/leave', 'auth', async (c) => {
    const q = c.url.searchParams
    const mine = !can(c.id, READ) || q.get('for') === 'mine'
    const rows = await c.db.prepare(`
      SELECT lr.id, COALESCE(NULLIF(${fullName('e.first_name', 'e.last_name')}, ''), NULLIF(${fullName('st.first_name', 'st.last_name')}, ''), '-') AS who,
             lr.subject_kind, lt.name AS leave_type, lr.from_date, lr.to_date, CAST(lr.days AS TEXT) AS days, lr.reason, lr.status
        FROM leave_requests lr LEFT JOIN employees e ON e.id = lr.employee_id LEFT JOIN students st ON st.id = lr.student_id LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE (? IS NULL OR lr.status = ?) AND (? IS NULL OR lr.subject_kind = ?) AND ${mine ? 'e.user_id = ?' : '1'}
       ORDER BY lr.created_at DESC LIMIT 300`)
      .bind(nz(q.get('status')), nz(q.get('status')), leaveFor(q), leaveFor(q), ...(mine ? [c.id.userId] : [])).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.get('/hr/leave-types', 'auth', async (c) => {
    const applies = (c.url.searchParams.get('applies_to') ?? '').trim()
    const rows = await c.db.prepare(`SELECT id, code, name, applies_to, annual_quota, is_paid, carry_forward FROM leave_types WHERE (? = '' OR applies_to = ?) ORDER BY applies_to, name`)
      .bind(applies, applies).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ id: v.id, code: v.code, name: v.name, applies_to: v.applies_to,
      annual_quota: v.annual_quota === null ? null : Number(v.annual_quota), is_paid: bool(v.is_paid), carry_forward: bool(v.carry_forward) })) })
  })

  r.post('/hr/leave-types', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const code = str(req.code).trim().toUpperCase(), name = str(req.name).trim()
    if (code === '' || name === '') throw badRequest('A leave type needs a short code and a name.')
    const applies = str(req.applies_to)
    if (applies !== 'staff' && applies !== 'student') throw badRequest('Leave applies either to staff or to students.')
    // DO NOTHING rather than upsert: a quota the school has since adjusted is not overwritten.
    const dup = await c.db.prepare(`SELECT 1 FROM leave_types WHERE institution_id = ? AND code = ? AND applies_to = ?`).bind(school(c).id, code, applies).first()
    if (dup) return ok({ created: 0 })
    const quota = typeof req.annual_quota === 'number' ? String(req.annual_quota) : null
    await c.db.prepare(`INSERT INTO leave_types (id, institution_id, code, name, applies_to, annual_quota, is_paid, carry_forward) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(uuid(), school(c).id, code, name, applies, quota, req.is_paid ? 1 : 0, req.carry_forward ? 1 : 0).run()
    return ok({ created: 1 })
  })

  r.del('/hr/leave-types/{id}', WRITE, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid leave type id')
    const t = await c.db.prepare(`SELECT (SELECT count(*) FROM leave_requests r WHERE r.leave_type_id = t.id) AS requests,
        (SELECT count(*) FROM leave_balances b WHERE b.leave_type_id = t.id AND (CAST(b.taken AS REAL) > 0 OR CAST(b.entitled AS REAL) > 0)) AS balances FROM leave_types t WHERE t.id = ?`)
      .bind(c.params.id).first<{ requests: number; balances: number }>()
    if (!t) throw badRequest('no such leave type in this school')
    if (t.requests > 0 || t.balances > 0) {
      const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
      throw badRequest(plural(t.requests, 'leave request', 'leave requests') + ' and ' + plural(t.balances, 'staff balance', 'staff balances') +
        ' refer to this type. It is how days already taken are described, so removing it would leave those days with no explanation. Set its quota to zero instead if the school no longer grants it')
    }
    await c.db.batch([
      c.db.prepare(`DELETE FROM leave_policy_rules WHERE leave_type_id = ?`).bind(c.params.id),
      c.db.prepare(`DELETE FROM leave_types WHERE id = ?`).bind(c.params.id),
    ])
    return ok({ id: c.params.id })
  })

  r.get('/hr/dashboard', READ, async (c) => {
    const today = todayIST()
    const k = await c.db.prepare(`
      SELECT (SELECT count(*) FROM employees WHERE status='active') AS headcount,
             (SELECT count(*) FROM staff_attendance WHERE on_date = ? AND status IN ('present','late')) AS present_today,
             (SELECT count(*) FROM staff_attendance WHERE on_date = ? AND status = 'absent') AS absent_today,
             (SELECT count(*) FROM leave_requests WHERE status='pending' AND subject_kind = 'staff') AS leave_pending,
             (SELECT count(*) FROM employees WHERE joined_on >= ?) AS new_joiners_30d,
             (SELECT count(*) FROM departments) AS departments`)
      .bind(today, today, addDays(today, -30)).first<Record<string, number>>()
    const away = await c.db.prepare(`
      SELECT ${fullName('e.first_name', 'e.last_name')} AS name, e.employee_code, 'marked absent' AS reason, NULL AS until
        FROM staff_attendance sa JOIN employees e ON e.user_id = sa.user_id WHERE sa.on_date = ? AND sa.status IN ('absent', 'leave')
      UNION
      SELECT ${fullName('e.first_name', 'e.last_name')}, e.employee_code, COALESCE(lt.name, 'on leave'), CASE WHEN lr.to_date > ? THEN lr.to_date END
        FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.subject_kind = 'staff' AND lr.status = 'approved' AND ? BETWEEN lr.from_date AND lr.to_date
       ORDER BY 1`).bind(today, today, today).all<{ name: string; employee_code: string; reason: string; until: string | null }>()
    const a = await c.db.prepare(`
      SELECT (SELECT count(*) FROM employees e WHERE e.status = 'active' AND NOT EXISTS (SELECT 1 FROM employee_documents d WHERE d.employee_id = e.id)) AS no_docs,
             (SELECT count(*) FROM employee_documents WHERE expires_on BETWEEN ? AND ?) AS expiring,
             (SELECT count(*) FROM employee_documents WHERE expires_on < ?) AS expired,
             (SELECT count(*) FROM employees e WHERE e.status = 'active' AND e.user_id IS NULL) AS no_login`)
      .bind(today, addDays(today, 60), today).first<{ no_docs: number; expiring: number; expired: number; no_login: number }>()
    const attention: { kind: string; text: string; count: number; link: string }[] = []
    const add = (n: number, kind: string, text: string, link: string) => { if (n > 0) attention.push({ kind, text, count: n, link }) }
    add(a!.expired, 'danger', 'staff documents have already lapsed', '/go/records/staff_records?view=documents')
    add(a!.expiring, 'warning', 'staff documents lapse within 60 days', '/go/records/staff_records?view=documents')
    add(a!.no_docs, 'warning', 'staff have no documents on file at all', '/go/records/staff_records?view=documents')
    add(a!.no_login, 'neutral', 'staff cannot sign in yet', '/go/records/staff_records')
    add(k!.leave_pending, 'warning', 'leave requests are waiting on somebody', '/go/leave/leave')
    return ok({ ...k, away_today: away.results.map((v) => omitNull({ name: v.name, employee_code: v.employee_code, reason: v.reason, until: v.until })), attention })
  })

  r.get('/hr/employees', READ, async (c) => {
    const q = c.url.searchParams
    const limit = clampInt(q.get('limit'), 50, 1, 200)
    const offset = clampInt(q.get('offset'), 0, 0, 1_000_000)
    const status = nz(q.get('status'))
    const fp = await filterFingerprint('employees', q.get('status') ?? '')
    const cur = decodeCursor(q.get('cursor') ?? '', fp)
    let withTotal = cur === null
    if (q.get('with_total') === '1') withTotal = true
    if (q.get('with_total') === '0') withTotal = false
    const from = `FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE (? IS NULL OR e.status = ?) AND (? IS NULL OR (COALESCE(e.employee_code, '') > ? OR (COALESCE(e.employee_code, '') = ? AND e.id > ?)))`
    const curCode = cur?.a ?? null, curID = cur?.i ?? null
    const out: Record<string, unknown> = { items: [], limit, offset, has_more: false }
    if (withTotal) out.total = (await c.db.prepare(`SELECT count(*) AS n ${from}`).bind(status, status, null, null, null, null).first<{ n: number }>())?.n ?? 0
    const rows = await c.db.prepare(`
      SELECT e.id, e.user_id, e.employee_code, e.staff_number, e.device_user_id, ${fullName('e.first_name', 'e.last_name')} AS full_name,
             d.name AS department, dg.name AS designation, e.phone, e.email, e.photo_file_id, e.joined_on, e.status,
             (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = e.user_id) AS periods_this_week
      ${from} ORDER BY COALESCE(e.employee_code, ''), e.id LIMIT ? OFFSET ?`)
      .bind(status, status, curCode, curCode, curCode, curID, limit + 1, cur ? 0 : offset).all<Record<string, unknown>>()
    let items = rows.results.map(omitNull)
    if (items.length > limit) {
      items = items.slice(0, limit)
      out.has_more = true
      const last = items[items.length - 1]
      out.next_cursor = encodeCursor({ a: str(last.employee_code), i: str(last.id), f: fp })
    }
    out.items = items
    return ok(out)
  })

  r.get('/hr/employees/unlinked', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT u.id AS user_id, u.full_name, u.email, u.phone, u.status,
             (SELECT json_group_array(ro2.name) FROM (SELECT DISTINCT ro.name FROM user_roles ur2 JOIN roles ro ON ro.id = ur2.role_id WHERE ur2.user_id = u.id AND ro.key NOT IN ('student','parent') ORDER BY ro.name) ro2) AS roles
        FROM users u
       WHERE u.status IN ('active', 'invited')
         AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = u.id AND ro.key NOT IN ('student', 'parent'))
         AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)
       ORDER BY u.full_name LIMIT 200`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, roles: parseJSON<string[]>(v.roles, []) })) })
  })

  r.get('/hr/staff/overview/report', READ, async (c) => {
    const refs = await c.db.prepare(`
      SELECT DISTINCT e.id, e.user_id, ${fullName('e.first_name', 'e.last_name')} AS name, COALESCE(dg.name, '') AS desig
        FROM section_subject_teachers sst JOIN employees e ON e.user_id = sst.teacher_user_id LEFT JOIN designations dg ON dg.id = e.designation_id ORDER BY 3`)
      .all<{ id: string; user_id: string; name: string; desig: string }>()
    let page = ''
    for (const ref of refs.results) {
      const ov = await computeStaffOverview(c.db, ref.id, ref.user_id, ref.name, ref.desig)
      page += `<div class="report page-break"><h1>${esc(staffReportTitle(ov))}</h1>${staffOverviewSection(ov)}</div>`
    }
    if (page === '') page = `<div class="report"><p class="empty">No teaching staff to report on yet.</p></div>`
    return ok({ html: page, css: staffOverviewCSS, filename: 'staff-overview-all.pdf' })
  })

  r.get('/hr/employees/{id}/detail', READ, async (c) => {
    const eid = c.params.id
    if (!isUUIDish(eid)) throw badRequest('invalid employee id')
    const e = await c.db.prepare(`
      SELECT e.employee_code, e.first_name, e.last_name, e.phone, e.email, e.qualification, d.name AS department, dg.name AS designation, e.department_id, e.designation_id,
             e.employment_type, e.status, e.joined_on, e.confirmed_on, e.relieved_on, e.address, e.photo_file_id, e.experience_years, e.user_id,
             e.emergency_contact_name, e.emergency_contact_phone, e.pan, e.bank_account, e.bank_ifsc, e.uan, e.esi_number, e.custom_fields
        FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id WHERE e.id = ?`).bind(eid).first<Record<string, unknown>>()
    if (!e) throw notFound()
    const out: Record<string, unknown> = {
      id: eid, employee_code: e.employee_code, full_name: (str(e.first_name) + ' ' + str(e.last_name)).trim(), first_name: e.first_name, last_name: e.last_name,
      phone: e.phone, email: e.email, qualification: e.qualification, department: e.department, designation: e.designation, department_id: e.department_id,
      designation_id: e.designation_id, employment_type: e.employment_type, status: e.status, joined_on: e.joined_on, confirmed_on: e.confirmed_on, relieved_on: e.relieved_on,
      address: e.address, photo_file_id: e.photo_file_id, experience_years: e.experience_years === null ? null : Math.trunc(Number(e.experience_years)), user_id: e.user_id,
      emergency_contact_name: e.emergency_contact_name, emergency_contact_phone: e.emergency_contact_phone, pan: e.pan, bank_account: e.bank_account, bank_ifsc: e.bank_ifsc,
      uan: e.uan, esi_number: e.esi_number,
    }
    const cf = parseJSON<Record<string, string>>(e.custom_fields, {})
    if (Object.keys(cf).length > 0) out.custom_fields = cf
    const docs = await c.db.prepare(`SELECT d.id, d.doc_type, d.file_id, date(d.created_at) AS uploaded_on, COALESCE(d.expires_on,'') AS expires_on, COALESCE(f.original_name,'') AS filename
        FROM employee_documents d LEFT JOIN files f ON f.id = d.file_id WHERE d.employee_id = ? ORDER BY d.expires_on IS NULL, d.expires_on, d.created_at DESC`).bind(eid).all()
    let teaching: unknown[] = [], classTeacherOf: unknown[] = []
    if (e.user_id) {
      teaching = (await c.db.prepare(`SELECT sst.id, c.name AS class, sec.name AS section, sub.name AS subject, sec.id AS section_id, cs.id AS class_subject_id
          FROM section_subject_teachers sst JOIN sections sec ON sec.id = sst.section_id JOIN classes c ON c.id = sec.class_id
          JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE sst.teacher_user_id = ? ORDER BY c.level, sec.name, sub.name`).bind(e.user_id).all()).results
      classTeacherOf = (await c.db.prepare(`SELECT sec.id AS section_id, c.name AS class, sec.name AS section,
          CAST((SELECT count(*) FROM enrollments en WHERE en.section_id = sec.id AND en.status = 'active') AS TEXT) AS students
          FROM sections sec JOIN classes c ON c.id = sec.class_id WHERE sec.class_teacher_id = ? ORDER BY c.level, sec.name`).bind(e.user_id).all()).results
    }
    const prior = await c.db.prepare(`SELECT year_name AS year, COALESCE(designation,'') AS designation, days_present, days_total, leaves_taken, COALESCE(notes,'') AS notes
        FROM employee_year_history WHERE employee_id = ? ORDER BY year_name DESC`).bind(eid).all()
    out.prior_years = prior.results; out.documents = docs.results; out.teaching = teaching; out.class_teacher_of = classTeacherOf
    return ok(out)
  })

  r.get('/hr/employees/{id}/overview', READ, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid employee id')
    const ov = await resolveStaffOverview(c.db, c.params.id)
    if (!ov) throw notFound()
    return ok(ov)
  })

  r.get('/hr/employees/{id}/overview/report', READ, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid employee id')
    const ov = await resolveStaffOverview(c.db, c.params.id)
    if (!ov) throw notFound()
    return ok({ html: `<div class="report"><h1>${esc(staffReportTitle(ov))}</h1>${staffOverviewSection(ov)}</div>`, css: staffOverviewCSS, filename: `staff-overview-${c.params.id}.pdf` })
  })

  r.get('/hr/documents', READ, async (c) => {
    const onlyExpiring = c.url.searchParams.get('expiring') === 'true'
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const today = todayIST()
    const rows = await c.db.prepare(`
      SELECT ed.id, ${fullName('e.first_name', 'e.last_name')} AS employee, e.employee_code, ed.doc_type, ed.expires_on,
             CASE WHEN ed.expires_on IS NULL THEN NULL ELSE CAST(julianday(ed.expires_on) - julianday(?) AS INTEGER) END AS days_left, date(ed.created_at) AS uploaded_on
        FROM employee_documents ed JOIN employees e ON e.id = ed.employee_id
       WHERE (NOT ? OR (ed.expires_on IS NOT NULL AND ed.expires_on <= ?)) AND ${mine.sql}
       ORDER BY ed.expires_on IS NULL, ed.expires_on LIMIT 300`).bind(today, onlyExpiring ? 1 : 0, addDays(today, 60), ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/hr/letters', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const empID = str(req.employee_id).trim()
    if (!isUUIDish(empID)) throw badRequest('Choose whose letter this is.')
    const kind = str(req.kind).trim().toUpperCase()
    const name = staffLetterKinds[kind]
    if (!name) throw badRequest('That is not a letter this school issues. Choose an appointment, salary revision, warning or service letter.')
    const body = str(req.body).trim()
    if (kind === 'WARNING' && body === '') throw badRequest('Say what the warning is about. A warning with no reason on it is worth nothing at a hearing.')
    const exists = await c.db.prepare(`SELECT 1 FROM employees WHERE id = ?`).bind(empID).first()
    if (!exists) throw badRequest("That member of staff is not on this school's roll.")
    const inst = school(c).id
    const { serial, stmts } = await issueStaffCertificate(c.db, inst, c.id.userId, empID, kind, body !== '' ? body : null)
    const entry = kind === 'APPOINTMENT' ? 'appointment' : kind === 'SALARY_REVISION' ? 'increment' : kind === 'WARNING' ? 'punishment' : 'other'
    stmts.push(c.db.prepare(`INSERT INTO service_book_entries (id, institution_id, employee_id, entry_kind, event_date, title, particulars, source, created_by, created_at) VALUES (?,?,?,?,?,?,?,'manual',?,?)`)
      .bind(uuid(), inst, empID, entry, todayIST(), `${name} issued (${serial})`, nz(body), c.id.userId, now()))
    await c.db.batch(stmts)
    return ok({ serial_no: serial, kind, name })
  })

  r.post('/hr/letters/printed', READ, async (c) => {
    const req = await readJSON(c.req)
    const serial = str(req.serial_no).trim()
    if (serial === '') throw badRequest('Say which letter was printed.')
    const cert = await c.db.prepare(`SELECT ic.id, ${fullName('e.first_name', 'e.last_name')} AS who FROM issued_certificates ic JOIN employees e ON e.id = ic.employee_id WHERE ic.serial_no = ?`)
      .bind(serial).first<{ id: string; who: string }>()
    if (!cert) throw notFound()
    const ip = c.req.headers.get('cf-connecting-ip')
    await c.db.prepare(`INSERT INTO audit_log (institution_id, actor_user_id, action, entity_type, entity_id, after, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(school(c).id, c.id.userId, 'PRINT staff_letter', 'hr.staff-letters', cert.id, JSON.stringify({ serial_no: serial, employee: cert.who }), ip, now()).run()
    return ok({ logged: true })
  })

  r.get('/hr/letters/prints', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT COALESCE(json_extract(a.after, '$.serial_no'), '') AS serial_no, COALESCE(json_extract(a.after, '$.employee'), '') AS employee,
             COALESCE(u.full_name, 'somebody since deleted') AS printed_by, ${istMinute('a.created_at')} AS printed_at
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.action = 'PRINT staff_letter' ORDER BY a.created_at DESC LIMIT 200`).all()
    return ok({ items: rows.results })
  })

  r.get('/hr/id-card-template', READ, async (c) => {
    const row = await c.db.prepare(`SELECT id_card_front_key, id_card_back_key FROM branding_profiles WHERE institution_id = ? AND campus_id IS NULL`).bind(school(c).id)
      .first<{ id_card_front_key: string | null; id_card_back_key: string | null }>()
    return ok(omitNull({ front_file_id: row?.id_card_front_key || undefined, back_file_id: row?.id_card_back_key || undefined }))
  })

  r.put('/hr/id-card-template', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const front = str(req.front_file_id).trim(), back = str(req.back_file_id).trim()
    const inst = school(c).id
    const existing = await c.db.prepare(`SELECT id FROM branding_profiles WHERE institution_id = ? AND campus_id IS NULL`).bind(inst).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE branding_profiles SET id_card_front_key = NULLIF(?,''), id_card_back_key = NULLIF(?,''), updated_at = ? WHERE id = ?`).bind(front, back, now(), existing.id).run()
    } else {
      await c.db.prepare(`INSERT INTO branding_profiles (id, institution_id, campus_id, id_card_front_key, id_card_back_key, updated_at) VALUES (?,?,NULL,NULLIF(?,''),NULLIF(?,''),?)`).bind(uuid(), inst, front, back, now()).run()
    }
    return ok(omitNull({ front_file_id: front || undefined, back_file_id: back || undefined }))
  })

  // --- the morning grace window (hr_punch_grace.go) ------------------------------------

  r.get('/hr/punch-grace', READ, async (c) => {
    const inst = school(c).id
    const scan = () => c.db.prepare(`SELECT substr(shift_starts_at,1,5) AS shift_starts_at, grace_minutes, late_half_day_after_minutes, late_marks_per_lop_day FROM leave_policy WHERE institution_id = ?`)
      .bind(inst).first<{ shift_starts_at: string; grace_minutes: number; late_half_day_after_minutes: number | null; late_marks_per_lop_day: number }>()
    let pol = await scan()
    if (!pol) {
      await c.db.prepare(`INSERT OR IGNORE INTO leave_policy (institution_id, updated_at) VALUES (?, ?)`).bind(inst, now()).run()
      pol = (await scan())!
    }
    const devices = await c.db.prepare(`SELECT count(*) AS n FROM biometric_devices WHERE is_active = 1`).first<{ n: number }>()
    const rows = await c.db.prepare(`
      SELECT ${fullName('e.first_name', 'e.last_name')} AS employee, sa.on_date, ${istClock('sa.check_in')} AS check_in,
             MAX(0, CAST((strftime('%s', ${istClock('sa.check_in')}) - strftime('%s', substr(pol.shift_starts_at,1,5))) / 60 AS INTEGER)) AS minutes_late,
             pol.late_half_day_after_minutes AS half
        FROM staff_attendance sa JOIN employees e ON e.user_id = sa.user_id JOIN leave_policy pol ON pol.institution_id = sa.institution_id
       WHERE sa.source = 'device' AND sa.check_in IS NOT NULL AND sa.on_date >= ?
         AND (strftime('%s', ${istClock('sa.check_in')}) - strftime('%s', substr(pol.shift_starts_at,1,5))) / 60 > pol.grace_minutes
       ORDER BY sa.on_date DESC, 4 DESC LIMIT 200`).bind(addDays(todayIST(), -14)).all<{ employee: string; on_date: string; check_in: string; minutes_late: number; half: number | null }>()
    const out = { ...pol, late_half_day_after_minutes: pol.late_half_day_after_minutes ?? undefined,
      recent: rows.results.map((p) => ({ employee: p.employee, on_date: p.on_date, check_in: p.check_in, minutes_late: p.minutes_late, half_day: p.half !== null && p.minutes_late >= p.half })),
      devices_on: devices?.n ?? 0 }
    return ok(omitNull(out))
  })

  r.put('/hr/punch-grace', WRITE, async (c) => {
    const req = await readJSON(c.req)
    let shift = str(req.shift_starts_at)
    if (shift === '') shift = '09:00'
    const grace = typeof req.grace_minutes === 'number' ? req.grace_minutes : 0
    const half = typeof req.late_half_day_after_minutes === 'number' ? req.late_half_day_after_minutes : null
    const marks = typeof req.late_marks_per_lop_day === 'number' ? req.late_marks_per_lop_day : 0
    if (!isHHMM(shift)) throw badRequest('shift start must be a time like 09:00')
    if (grace < 0 || grace > 240) throw badRequest('grace must be between 0 and 240 minutes')
    if (half !== null && half <= grace) throw badRequest('the half-day threshold must be later than the grace window')
    if (marks <= 0) throw badRequest('say how many late marks make a day; zero would charge a day for every one')
    await c.db.prepare(`INSERT INTO leave_policy (institution_id, shift_starts_at, grace_minutes, late_half_day_after_minutes, late_marks_per_lop_day, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT (institution_id) DO UPDATE SET shift_starts_at = excluded.shift_starts_at, grace_minutes = excluded.grace_minutes,
        late_half_day_after_minutes = excluded.late_half_day_after_minutes, late_marks_per_lop_day = excluded.late_marks_per_lop_day, updated_at = excluded.updated_at`)
      .bind(school(c).id, shift + ':00', grace, half, marks, now()).run()
    return ok(omitNull({ shift_starts_at: shift, grace_minutes: grace, late_half_day_after_minutes: half ?? undefined, late_marks_per_lop_day: marks }))
  })
}

