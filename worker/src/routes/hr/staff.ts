import type { Router } from '../../router'
import { DOC_PRINT_CSS, documentHTML, schoolFacts } from '../../services/document'
import type { Employee, HRAlert, HRAway, HRDashboard, Page } from '@shared/api'
import { badRequest, bool, clampInt, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { addDays, fullName, isHHMM, isUUIDish, istClock, istMinute, nextNumber, nz, parseJSON, round1, str, todayIST } from '../admissions/util'
import { employeeFilter, growthReach } from './reach'
import { overviewExtras, staffOverviewDoc } from './staff_overview_doc'
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
.report { padding: 0; }
.report + .report { margin-top: 18pt; }
.report h1 { font-size: 20px; margin: 0 0 12px; }
.report h2 { font-size: 12pt; margin: 14pt 0 6pt; color: #111827; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.stat { border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 14px; min-width: 90px; }
.stat .num { font-size: 20px; font-weight: 700; }
.stat .lbl { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
.ct { font-size: 12px; color: #444; margin: 4px 0 10px; }
.empty { font-style: italic; color: #888; }
.page-break + .page-break { page-break-before: always; }
@media print {
  body { margin: 0; }
  .report { padding: 0; }
  .page-break + .page-break { page-break-before: always; }
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
type PayLine = { name: string; kind: string; amount_paise: number; component_id: string }
/** The pay lines in force on a date: earnings first, in payroll order. */
async function payOn(db: D1Database, emp: string, on: string): Promise<{ structureId: string | null; lines: PayLine[] }> {
  const ss = await db.prepare(`SELECT id FROM salary_structures WHERE employee_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1`).bind(emp, on, on).first<{ id: string }>()
  if (!ss) return { structureId: null, lines: [] }
  const it = await db.prepare(`SELECT sc.id AS component_id, sc.name, sc.kind, ssi.amount_paise FROM salary_structure_items ssi JOIN salary_components sc ON sc.id = ssi.component_id WHERE ssi.salary_structure_id = ? ORDER BY sc.kind = 'deduction', sc.sequence, sc.name`).bind(ss.id).all<PayLine>()
  return { structureId: ss.id, lines: (it.results ?? []).map((l) => ({ ...l, amount_paise: Number(l.amount_paise) || 0 })) }
}

export async function issueStaffCertificate(db: D1Database, inst: string, actor: string, emp: string, code: string, remarks: string | null,
  opts: { salary?: { new_gross_paise: number; effective_from: string } } = {}): Promise<{ serial: string; stmts: D1PreparedStatement[] }> {
  const stmts: D1PreparedStatement[] = []
  let typeID = (await db.prepare(`SELECT id FROM certificate_types WHERE code = ?`).bind(code).first<{ id: string }>())?.id
  if (!typeID) {
    typeID = uuid()
    stmts.push(db.prepare(`INSERT INTO certificate_types (id, institution_id, code, name, requires_approval, updated_at) VALUES (?,?,?,?,0,?)`).bind(typeID, inst, code, staffCertificateName(code), now()))
  }
  const serial = await nextNumber(db, inst, 'certificate')
  const e = await db.prepare(`SELECT ${fullName('e.first_name', 'e.last_name')} AS name, e.employee_code, d.name AS designation, dep.name AS department, e.joined_on, e.relieved_on,
      e.employment_type, e.address, e.qualification, e.gender, e.user_id
      FROM employees e LEFT JOIN designations d ON d.id = e.designation_id LEFT JOIN departments dep ON dep.id = e.department_id WHERE e.id = ?`).bind(emp)
    .first<{ name: string; employee_code: string; designation: string | null; department: string | null; joined_on: string; relieved_on: string | null
      employment_type: string | null; address: string | null; qualification: string | null; gender: string | null; user_id: string | null }>()
  if (!e) throw badRequest('That member of staff is not on this school\'s roll.')
  const quals = await db.prepare(`SELECT qualification FROM staff_qualifications WHERE employee_id = ? ORDER BY year_of_passing`).bind(emp).all<{ qualification: string }>()
  const today = todayIST()
  const relieved = e.relieved_on ?? today
  const years = Math.max(0, Math.floor((Date.parse(relieved) - Date.parse(e.joined_on)) / (365.25 * 86_400_000)))
  /* What the letter prints, frozen today (owner's letter designs, 2026-10-06):
     the pay lines in force, and for a salary revision the old and new lines. */
  const pay = await payOn(db, emp, code === 'APPOINTMENT' ? (e.joined_on ?? today) : today)
  const subjects = e.user_id ? ((await db.prepare(`SELECT DISTINCT sub.name FROM section_subject_teachers sst JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id WHERE sst.teacher_user_id = ? ORDER BY sub.name`).bind(e.user_id).all<{ name: string }>()).results ?? []).map((x) => x.name) : []
  let revision: { effective_from: string; old: PayLine[]; new: PayLine[] } | undefined
  if (code === 'SALARY_REVISION' && opts.salary) {
    const { new_gross_paise, effective_from } = opts.salary
    const earn = pay.lines.filter((l) => l.kind !== 'deduction')
    const oldGross = earn.reduce((n, l) => n + l.amount_paise, 0)
    if (oldGross <= 0) throw badRequest('This person has no salary set up in payroll yet. Set their pay first (Payroll → salary), then revise it.')
    const factor = new_gross_paise / oldGross
    const scaled = earn.map((l) => ({ ...l, amount_paise: Math.round((l.amount_paise * factor) / 100) * 100 }))
    // Rounding to whole rupees can leave a few rupees over or under; it goes on the first line (Basic).
    const drift = new_gross_paise - scaled.reduce((n, l) => n + l.amount_paise, 0)
    if (scaled[0]) scaled[0].amount_paise += drift
    const ded = pay.lines.filter((l) => l.kind === 'deduction')
    revision = { effective_from, old: pay.lines, new: [...scaled, ...ded] }
    // The letter and payroll can never disagree: the new pay is written as payroll's structure from that date.
    const dayBefore = new Date(effective_from + 'T00:00:00Z'); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
    const sid = uuid()
    stmts.push(
      db.prepare(`UPDATE salary_structures SET effective_to = ? WHERE employee_id = ? AND effective_to IS NULL AND effective_from < ?`).bind(dayBefore.toISOString().slice(0, 10), emp, effective_from),
      db.prepare(`DELETE FROM salary_structure_items WHERE salary_structure_id IN (SELECT id FROM salary_structures WHERE employee_id = ? AND effective_from = ?)`).bind(emp, effective_from),
      db.prepare(`DELETE FROM salary_structures WHERE employee_id = ? AND effective_from = ?`).bind(emp, effective_from),
      db.prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(sid, inst, emp, effective_from, new_gross_paise * 12, now()),
      ...revision.new.map((l) => db.prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise, percent) VALUES (?, ?, ?, ?, ?, NULL)`).bind(uuid(), inst, sid, l.component_id, l.amount_paise)),
    )
  }
  const snapshot = { name: e.name, employee_code: e.employee_code, designation: e.designation, department: e.department, joined_on: e.joined_on, relieved_on: relieved,
    years_of_service: years, qualifications: quals.results.map((q) => q.qualification), qualification: e.qualification, employment_type: e.employment_type,
    address: e.address, gender: e.gender, subjects, pay: pay.lines, revision, conduct: 'good', remarks, issued_at: now() }
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

  r.typed('GET /hr/dashboard', READ, async (c) => {
    const today = todayIST()
    const k = await c.db.prepare(`
      SELECT (SELECT count(*) FROM employees WHERE status='active') AS headcount,
             (SELECT count(*) FROM staff_attendance WHERE on_date = ? AND status IN ('present','late')) AS present_today,
             (SELECT count(*) FROM staff_attendance WHERE on_date = ? AND status = 'absent') AS absent_today,
             (SELECT count(*) FROM leave_requests WHERE status='pending' AND subject_kind = 'staff') AS leave_pending,
             (SELECT count(*) FROM employees WHERE joined_on >= ?) AS new_joiners_30d,
             (SELECT count(*) FROM departments) AS departments`)
      .bind(today, today, addDays(today, -30))
      .first<Omit<HRDashboard, 'away_today' | 'attention'>>()
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
    const attention: HRAlert[] = []
    const add = (n: number, kind: HRAlert['kind'], text: string, link: string) => { if (n > 0) attention.push({ kind, text, count: n, link }) }
    add(a!.expired, 'danger', 'staff documents have already lapsed', '/go/records/staff_records?view=documents')
    add(a!.expiring, 'warning', 'staff documents lapse within 60 days', '/go/records/staff_records?view=documents')
    add(a!.no_docs, 'warning', 'staff have no documents on file at all', '/go/records/staff_records?view=documents')
    add(a!.no_login, 'neutral', 'staff cannot sign in yet', '/go/records/staff_records')
    add(k!.leave_pending, 'warning', 'leave requests are waiting on somebody', '/go/leave/leave')
    return { ...k!, away_today: away.results.map((v): HRAway => omitNull({ name: v.name, employee_code: v.employee_code, reason: v.reason, until: v.until ?? undefined })), attention }
  })

  r.typed('GET /hr/employees', READ, async (c) => {
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
    const out: Page<Employee> = { items: [], limit, offset, has_more: false }
    if (withTotal) out.total = (await c.db.prepare(`SELECT count(*) AS n ${from}`).bind(status, status, null, null, null, null).first<{ n: number }>())?.n ?? 0
    const rows = await c.db.prepare(`
      SELECT e.id, e.user_id, e.employee_code, e.staff_number, e.device_user_id, ${fullName('e.first_name', 'e.last_name')} AS full_name,
             d.name AS department, dg.name AS designation, e.phone, e.email, e.photo_file_id, e.joined_on, e.status,
             (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = e.user_id) AS periods_this_week
      ${from} ORDER BY COALESCE(e.employee_code, ''), e.id LIMIT ? OFFSET ?`)
      .bind(status, status, curCode, curCode, curCode, curID, limit + 1, cur ? 0 : offset).all<Record<string, unknown>>()
    let items = rows.results.map((r) => omitNull(r) as unknown as Employee)
    if (items.length > limit) {
      items = items.slice(0, limit)
      out.has_more = true
      const last = items[items.length - 1]
      out.next_cursor = encodeCursor({ a: str(last.employee_code), i: str(last.id), f: fp })
    }
    out.items = items
    return out
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

  /* EVERY MEMBER OF STAFF ON ONE SHEET, WITH WHAT THEY ACTUALLY TEACH.

     The directory exports what the directory shows -- a name, a code, a
     department -- which answers none of the questions a timetable meeting
     opens with: who is class teacher of 6B, who takes Physics anywhere, who
     is carrying four classes and who is carrying one. Those live on
     section_subject_teachers and sections.class_teacher_id and were readable
     one employee at a time, through Staff 360, and nowhere in bulk.

     Three filters, because an export nobody can narrow is a file somebody
     then narrows by hand in a spreadsheet:
       status=active|inactive|all   (default active: the leavers are the
                                     minority case and including them silently
                                     is how a payroll count goes wrong)
       class_id=<id>                only staff who teach that class or are
                                     class teacher of one of its sections
       teaching=1                   only staff with a teaching load at all

     One query per list rather than one per employee: a school of 120 staff
     would otherwise be 240 round trips. */
  r.get('/hr/staff/export', READ, async (c) => {
    const q = c.url.searchParams
    const status = (q.get('status') ?? 'active').toLowerCase()
    const classID = nz(q.get('class_id'))
    const teachingOnly = q.get('teaching') === '1'
    /* LEFT IS NOT A STATUS, IT IS EVERY STATUS BUT ONE.

       A school's leavers are 'resigned' and 'terminated' here, and nothing is
       ever stored as 'inactive' -- so matching the word would have returned an
       empty file and said nothing was wrong with it. Measured on JSM: 20
       active, 1 resigned, 1 terminated. */
    const leavers = status === 'inactive'
    const byStatus = status === 'all' || leavers ? null : status

    const rows = (await c.db.prepare(`
      SELECT e.id, e.user_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name,
             COALESCE(dg.name, '') AS designation, COALESCE(d.name, '') AS department,
             COALESCE(e.phone, '') AS phone, COALESCE(e.email, '') AS email,
             COALESCE(e.employment_type, '') AS employment_type, e.status,
             COALESCE(e.joined_on, '') AS joined_on, COALESCE(e.qualification, '') AS qualification,
             COALESCE(e.experience_years, '') AS experience_years
        FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE (?1 IS NULL OR e.status = ?1) AND (?2 = 0 OR e.status <> 'active')
       ORDER BY COALESCE(e.employee_code, ''), e.id`).bind(byStatus, leavers ? 1 : 0).all<Record<string, unknown>>()).results

    /* The teaching load for everyone at once: class, section and subject per
       assignment, so the export can say both which classes and which
       subjects without asking twice. */
    const load = (await c.db.prepare(`
      SELECT sst.teacher_user_id AS uid, c.id AS class_id, c.name AS class, sec.name AS section, sub.name AS subject
        FROM section_subject_teachers sst
        JOIN sections sec ON sec.id = sst.section_id
        JOIN classes c ON c.id = sec.class_id
        JOIN class_subjects cs ON cs.id = sst.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
       ORDER BY c.level, sec.name, sub.name`).all<Record<string, string>>()).results

    const ct = (await c.db.prepare(`
      SELECT sec.class_teacher_id AS uid, c.id AS class_id, c.name AS class, sec.name AS section
        FROM sections sec JOIN classes c ON c.id = sec.class_id
       WHERE sec.class_teacher_id IS NOT NULL
       ORDER BY c.level, sec.name`).all<Record<string, string>>()).results

    /* WHICH SUBJECT IN WHICH CLASS, not two lists side by side.

       "Grade 6 B; Grade 7 A" beside "English; Mathematics" does not say who
       takes Mathematics where -- it could be either class, or both, and the
       reader has to open Staff 360 to find out, which is the trip this export
       exists to save. The pairing is kept as well as the two lists, because a
       spreadsheet still wants to filter on a subject alone. */
    const teaches = new Map<string, {
      classes: Set<string>; subjects: Set<string>; classIDs: Set<string>; pairs: Map<string, Set<string>>
    }>()
    for (const r of load) {
      let t = teaches.get(r.uid)
      if (!t) { t = { classes: new Set(), subjects: new Set(), classIDs: new Set(), pairs: new Map() }; teaches.set(r.uid, t) }
      const where = `${r.class} ${r.section}`.trim()
      t.classes.add(where)
      t.subjects.add(r.subject)
      t.classIDs.add(r.class_id)
      let subs = t.pairs.get(where)
      if (!subs) { subs = new Set(); t.pairs.set(where, subs) }
      subs.add(r.subject)
    }
    const classOf = new Map<string, { sections: Set<string>; classIDs: Set<string> }>()
    for (const r of ct) {
      let t = classOf.get(r.uid)
      if (!t) { t = { sections: new Set(), classIDs: new Set() }; classOf.set(r.uid, t) }
      t.sections.add(`${r.class} ${r.section}`.trim())
      t.classIDs.add(r.class_id)
    }

    const items = []
    for (const e of rows) {
      const uid = str(e.user_id)
      const t = uid ? teaches.get(uid) : undefined
      const ctOf = uid ? classOf.get(uid) : undefined
      if (teachingOnly && !t && !ctOf) continue
      if (classID) {
        const hit = (t?.classIDs.has(classID) ?? false) || (ctOf?.classIDs.has(classID) ?? false)
        if (!hit) continue
      }
      items.push({
        /* The directory filters its own rows against this list, so the row
           has to be identifiable: a staff code can be blank or repeated. */
        id: str(e.id),
        employee_code: str(e.employee_code),
        full_name: str(e.full_name),
        designation: str(e.designation),
        department: str(e.department),
        status: str(e.status),
        employment_type: str(e.employment_type),
        phone: str(e.phone),
        email: str(e.email),
        joined_on: str(e.joined_on),
        qualification: str(e.qualification),
        experience_years: e.experience_years === '' ? '' : String(e.experience_years),
        class_teacher_of: [...(ctOf?.sections ?? [])].join('; '),
        classes_taught: [...(t?.classes ?? [])].join('; '),
        subjects_taught: [...(t?.subjects ?? [])].join('; '),
        teaching_load: [...(t?.pairs ?? new Map<string, Set<string>>())]
          .map(([where, subs]) => `${where}: ${[...subs].join(', ')}`)
          .join('; '),
        periods_count: String(t?.classes.size ?? 0),
      })
    }
    return ok({ items, total: items.length })
  })

  /* THE PRINTOUT IS WHAT THE DIRECTORY IS SHOWING.

     It printed every teacher in the school whatever the screen had been
     narrowed to, so the two filters beside the button meant nothing to it --
     choose one class, press Print, get a hundred pages. It takes the same two
     now. There is no tick-box selection and deliberately so: what people
     actually want is a class or the leavers, which the filters already say,
     and a selection model would be a second way to answer the same question.

     Still teaching staff only. The page is a teaching load and its results; a
     driver has neither, and a blank sheet per driver is not a report. The
     subtitle says which of the two numbers it is printing. */
  r.get('/hr/staff/overview/report', READ, async (c) => {
    const q = c.url.searchParams
    const status = (q.get('status') ?? 'all').toLowerCase()
    const classID = nz(q.get('class_id'))
    const leavers = status === 'inactive'
    const byStatus = status === 'all' || leavers ? null : status
    /* A CLASS TEACHER WITH NO SUBJECT IS STILL A TEACHER.

       The list was built from subject assignments alone, so the person who
       holds Nursery A and teaches no named subject was on the directory and
       missing from its printout -- filter to Nursery, see one person, print,
       get nothing. Whoever is class teacher of a section counts too. */
    const refs = await c.db.prepare(`
      SELECT DISTINCT e.id, e.user_id, ${fullName('e.first_name', 'e.last_name')} AS name, COALESCE(dg.name, '') AS desig
        FROM employees e
        LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE (?1 IS NULL OR e.status = ?1)
         AND (?2 = 0 OR e.status <> 'active')
         AND e.user_id IS NOT NULL
         AND (
           EXISTS (SELECT 1 FROM section_subject_teachers sst JOIN sections s2 ON s2.id = sst.section_id
                    WHERE sst.teacher_user_id = e.user_id AND (?3 IS NULL OR s2.class_id = ?3))
           OR EXISTS (SELECT 1 FROM sections s3
                       WHERE s3.class_teacher_id = e.user_id AND (?3 IS NULL OR s3.class_id = ?3))
         )
       ORDER BY 3`)
      .bind(byStatus, leavers ? 1 : 0, classID)
      .all<{ id: string; user_id: string; name: string; desig: string }>()
    let page = ''
    for (const ref of refs.results) {
      const ov = await computeStaffOverview(c.db, ref.id, ref.user_id, ref.name, ref.desig)
      page += `<div class="report page-break"><h1>${esc(staffReportTitle(ov))}</h1>${staffOverviewSection(ov)}</div>`
    }
    if (page === '') {
      page = `<div class="report"><p class="empty">No teaching staff match what the directory is showing.</p></div>`
    }
    const facts = await schoolFacts(c.db, c.id.institution!)
    return ok({ html: documentHTML(facts, { title: 'Staff overview', subtitle: `${refs.results.length} teaching staff` }, page), css: staffOverviewCSS + DOC_PRINT_CSS, filename: 'staff-overview-all.pdf' })
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
    const facts = await schoolFacts(c.db, c.id.institution!)
    /* The owner's design, with the extra figures (staff_overview_doc.ts). */
    const person = await c.db.prepare(`SELECT e.employee_code, e.first_name, e.last_name, e.phone, e.email, e.qualification, e.employment_type, e.status, e.joined_on,
        e.date_of_birth, e.gender, e.address, e.photo_file_id, e.experience_years, e.emergency_contact_name, e.emergency_contact_phone, e.user_id,
        d.name AS department, dg.name AS designation
        FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id WHERE e.id = ?`)
      .bind(c.params.id).first<Record<string, unknown>>()
    if (!person) throw notFound()
    const me = await c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(c.id.userId).first<{ full_name: string }>()
    const extras = await overviewExtras(c.db, c.params.id, (person.user_id as string | null) ?? null)
    const doc = staffOverviewDoc({ facts, printedBy: me?.full_name ?? '', person, load: ov.load, marks: ov.marks }, extras)
    return ok({ html: doc.html, css: doc.css, filename: `staff-overview-${c.params.id}.pdf` })
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
    let salary: { new_gross_paise: number; effective_from: string } | undefined
    if (kind === 'SALARY_REVISION') {
      const gross = Math.round(Number(req.new_gross) * 100)
      const from = str(req.effective_from).trim()
      if (!(gross > 0)) throw badRequest('Enter the new monthly gross salary.')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw badRequest('Enter the date the new salary starts.')
      salary = { new_gross_paise: gross, effective_from: from }
    }
    const { serial, stmts } = await issueStaffCertificate(c.db, inst, c.id.userId, empID, kind, body !== '' ? body : null, { salary })
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

