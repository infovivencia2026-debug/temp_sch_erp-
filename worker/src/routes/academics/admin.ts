import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, created, isUUID, ok, readJSON, uuid, now, like } from '../../http'
import {
  academicYearStart, addDays, adminWindow, batch, coded, daysBetween, indiaToday, inst, isDate, isodow, nullStr, parseJSON, str,
  weekdayOf, workingYear, workingYearSQL,
} from '../students/common'
import { planReplaceSyllabusUnits, type PlanUnit } from '../academics'

/* Port of mountAdminAcademics (internal/api/admin_academics.go plus
   calendar_day.go, year_plan.go, year_plan_import.go, exam_publish.go and
   allocation_apply.go), mounted under /academics. */

export function registerAdminAcademics(r: Router) {
  r.get('/academics/admin/calendar', 'academics.read', getAcademicCalendar)
  r.get('/academics/admin/calendar/day', 'academics.read', getCalendarDay)
  r.get('/academics/admin/year-plan', 'academics.read', getYearPlan)
  r.post('/academics/admin/year-plan/import', 'academics.write', importYearPlan)
  r.get('/academics/admin/year-plan/template', 'academics.read', () =>
    new Response('Subject,Sheet_Name,TOPICS,NUMBER OF PERIODS\nMathematics,G-6,Knowing our numbers,8\nMathematics,G-6,Whole numbers,6\nScience,G-6,Food: where does it come from,5\n',
      { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="year-plan-template.csv"' } }))
  r.post('/academics/admin/calendar', 'academics.write', saveCalendarEntry)
  r.del('/academics/admin/calendar/{id}', 'academics.write', deleteCalendarEntry)
  r.get('/academics/admin/exam-monitor', 'admin.reports.read', getExamMonitor)
  r.post('/academics/admin/exam-monitor/approve', 'academics.exams.write', approveExamMarks)
  r.post('/academics/admin/exam-monitor/publish', 'academics.exams.approve', publishExamResults)
  r.get('/academics/admin/faculty-allocation', 'academics.write', getFacultyAllocation)
  r.post('/academics/admin/faculty-allocation', 'academics.write', setFacultyAllocation)
  r.post('/academics/admin/faculty-allocation/apply', 'academics.write', applyAllocationToTimetable)
  r.get('/academics/admin/substitution-board', 'academics.timetable.write', getSubstitutionBoard)
  r.get('/academics/admin/outcomes', 'admin.reports.read', getOutcomes)
  r.get('/academics/admin/outcomes/attainment', 'admin.reports.read', getOutcomeAttainment)
  r.post('/academics/admin/outcomes/programme', 'academics.write', saveProgrammeOutcome)
  r.post('/academics/admin/outcomes/course', 'academics.write', saveCourseOutcome)
  r.put('/academics/admin/outcomes/mapping', 'academics.write', setOutcomeMapping)
  r.get('/academics/admin/department-students', 'students.read.all', getDepartmentStudents)
  r.get('/academics/admin/incidents', 'students.read.all', listIncidents)
  r.post('/academics/admin/incidents/{id}', 'students.write', updateIncident)
  r.get('/academics/admin/council', 'students.read.all', getCouncil)
  r.post('/academics/admin/council/positions', 'students.write', saveCouncilPosition)
  r.post('/academics/admin/council/members', 'students.write', saveCouncilMember)
  r.post('/academics/admin/council/duties', 'students.write', saveCouncilDuty)
  r.get('/academics/admin/alumni', 'students.read.all', getAlumni)
  r.get('/academics/admin/alumni/events', 'students.read.all', listAlumniEvents)
  r.post('/academics/admin/alumni/profiles', 'students.write', saveAlumniProfile)
  r.post('/academics/admin/alumni/events', 'students.write', saveAlumniEvent)
  r.post('/academics/admin/alumni/events/{id}/attendance', 'students.write', recordAlumniAttendance)
  r.post('/academics/admin/alumni/contributions', 'students.write', recordAlumniContribution)
  r.get('/academics/admin/certificate-templates', 'institution.read', listCertificateTemplates)
  r.get('/academics/admin/certificate-templates/{id}/preview', 'institution.read', previewCertificateTemplate)
  r.post('/academics/admin/certificate-templates', 'institution.settings.write', saveCertificateTemplate)
}

const notFoundGo = () => new HttpError(404, 'resource not found', { code: 'not_found' })
const omitNull = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (o[k] === null || o[k] === undefined) delete o[k]; return o }
const q = (c: Ctx, k: string) => (c.url.searchParams.get(k) ?? '').trim()
const fullName = (a: string) => `trim(replace(${a}.first_name || ' ' || COALESCE(${a}.middle_name,'') || ' ' || COALESCE(${a}.last_name,''), '  ', ' '))`
/** The active enrolment's section and class for a students alias (the LATERAL join in Go). */
const CUR_ENROLMENT = `LEFT JOIN enrollments cur ON cur.id = (SELECT en.id FROM enrollments en WHERE en.student_id = st.id AND en.status = 'active' ORDER BY en.enrolled_on DESC LIMIT 1)
  LEFT JOIN sections sec ON sec.id = cur.section_id LEFT JOIN classes c ON c.id = cur.class_id`

// --- academic calendar -----------------------------------------------------------------------------

interface CalendarEntry { id: string; source: string; name: string; starts_on: string; ends_on: string; kind: string; applies_to: string; description?: string | null; campus?: string | null; days: number }

async function calendarEntries(c: Ctx, from: string, to: string, kind: string | null, yearId: string | null): Promise<CalendarEntry[]> {
  const rows = await c.db.prepare(`
    SELECT h.id, 'calendar' AS source, h.name, h.on_date AS starts_on, COALESCE(h.to_date, h.on_date) AS ends_on, h.kind, h.applies_to, h.description, c.name AS campus
      FROM holidays h LEFT JOIN campuses c ON c.id = h.campus_id
     WHERE h.on_date <= ? AND COALESCE(h.to_date, h.on_date) >= ? AND (? IS NULL OR h.kind = ?) AND (? IS NULL OR h.academic_year_id = ?)
    UNION ALL
    SELECT e.id, 'exam', e.name, e.starts_on, COALESCE(e.ends_on, e.starts_on), 'exam', 'students', NULL, NULL
      FROM exams e WHERE e.starts_on IS NOT NULL AND e.starts_on <= ? AND COALESCE(e.ends_on, e.starts_on) >= ?
       AND (? IS NULL OR ? = 'exam') AND (? IS NULL OR e.academic_year_id = ?)
    UNION ALL
    SELECT t.id, 'term', t.name, t.starts_on, t.ends_on, 'term', 'all', NULL, NULL
      FROM terms t WHERE t.starts_on <= ? AND t.ends_on >= ? AND (? IS NULL OR ? = 'term') AND (? IS NULL OR t.academic_year_id = ?)
     ORDER BY 4, 3`).bind(to, from, kind, kind, yearId, yearId, to, from, kind, kind, yearId, yearId, to, from, kind, kind, yearId, yearId)
    .all<Omit<CalendarEntry, 'days'>>()
  return rows.results.map((e) => ({ ...e, days: daysBetween(e.starts_on, e.ends_on) + 1 }))
}

interface DayMarks { shut: boolean; working: boolean; examined: boolean }
/** Per-day flags for a range, the way generate_series + EXISTS did it in Postgres. */
async function markDays(c: Ctx, from: string, to: string, withExams: boolean): Promise<Map<string, DayMarks>> {
  const hol = await c.db.prepare(`SELECT on_date, COALESCE(to_date, on_date) AS to_date, kind, applies_to FROM holidays WHERE on_date <= ? AND COALESCE(to_date, on_date) >= ?`)
    .bind(to, from).all<{ on_date: string; to_date: string; kind: string; applies_to: string }>()
  const exams = withExams
    ? await c.db.prepare(`SELECT starts_on, COALESCE(ends_on, starts_on) AS ends_on FROM exams WHERE starts_on IS NOT NULL AND starts_on <= ? AND COALESCE(ends_on, starts_on) >= ?`)
      .bind(to, from).all<{ starts_on: string; ends_on: string }>()
    : { results: [] as { starts_on: string; ends_on: string }[] }
  const days = new Map<string, DayMarks>()
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const m: DayMarks = { shut: false, working: false, examined: false }
    for (const h of hol.results) {
      if (d < h.on_date || d > h.to_date) continue
      if ((h.kind === 'holiday' || h.kind === 'vacation') && (h.applies_to === 'all' || h.applies_to === 'students')) m.shut = true
      if (h.kind === 'working_day') m.working = true
    }
    for (const e of exams.results) if (d >= e.starts_on && d <= e.ends_on) m.examined = true
    days.set(d, m)
  }
  return days
}
const isOpen = (d: string, m: DayMarks) => m.working || (isodow(d) !== 7 && !m.shut)

async function getAcademicCalendar(c: Ctx) {
  const [from, to] = adminWindow(c)
  const kind = nullStr(q(c, 'kind')), yearId = nullStr(q(c, 'academic_year_id'))
  const items = await calendarEntries(c, from, to, kind, yearId)
  const days = await markDays(c, from, to, false)
  let total = 0, instructional = 0
  for (const [d, m] of days) { total++; if (isOpen(d, m)) instructional++ }
  const declaredRow = await c.db.prepare(`SELECT working_days FROM academic_years WHERE is_current = 1 ORDER BY starts_on DESC LIMIT 1`).first<{ working_days: number | null }>()
  const declared = declaredRow?.working_days ?? 0
  return ok({
    items: items.map((e) => omitNull({ ...e }, ['description', 'campus'])), from, to,
    summary: { days_in_range: total, instructional_days: instructional, declared_working: declared, has_declared_figure: declared > 0, entries: items.length },
  })
}

const calendarKinds = new Set(['holiday', 'vacation', 'exam', 'event', 'ptm', 'working_day'])

async function saveCalendarEntry(c: Ctx) {
  const req = await readJSON<{ id?: string; name?: string; on_date?: string; to_date?: string; kind?: string; applies_to?: string; description?: string; campus_id?: string; academic_year_id?: string }>(c.req)
  const name = str(req.name).trim()
  if (name === '') throw badRequest('give the entry a name. A dated blank tells the next reader nothing')
  if (str(req.on_date).trim() === '') throw badRequest('on_date is required')
  const kind = req.kind || 'holiday'
  if (!calendarKinds.has(kind)) throw badRequest('kind must be one of holiday, vacation, exam, event, ptm, working_day')
  const appliesTo = req.applies_to || 'all'
  if (!['all', 'students', 'staff'].includes(appliesTo)) throw badRequest('applies_to must be all, students or staff')
  const toDate = str(req.to_date)
  if (toDate !== '' && toDate < str(req.on_date)) throw badRequest('to_date is before on_date')
  const campus = nullStr(str(req.campus_id)), yearIn = nullStr(str(req.academic_year_id))
  if (req.id) {
    const res = await c.db.prepare(`UPDATE holidays SET name = ?, on_date = ?, to_date = ?, kind = ?, applies_to = ?, description = ?, campus_id = ?,
        academic_year_id = COALESCE(?, academic_year_id) WHERE id = ?`)
      .bind(name, req.on_date, nullStr(toDate), kind, appliesTo, nullStr(str(req.description)), campus, yearIn, req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  const year = await workingYear(c, str(req.academic_year_id))
  // The entry key from 00034: (institution, campus, on_date, kind, lower(name)).
  const existing = await c.db.prepare(`SELECT id FROM holidays WHERE institution_id = ? AND COALESCE(campus_id,'') = COALESCE(?,'') AND on_date = ? AND kind = ? AND lower(name) = lower(?)`)
    .bind(inst(c), campus, req.on_date, kind, name).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE holidays SET to_date = ?, applies_to = ?, description = ?, academic_year_id = COALESCE(?, academic_year_id) WHERE id = ?`)
      .bind(nullStr(toDate), appliesTo, nullStr(str(req.description)), year, existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO holidays (id, institution_id, campus_id, academic_year_id, name, on_date, to_date, kind, applies_to, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), campus, year, name, req.on_date, nullStr(toDate), kind, appliesTo, nullStr(str(req.description))).run()
  return ok({ id })
}

async function deleteCalendarEntry(c: Ctx) {
  const id = c.params.id
  if (!isUUID(id)) throw badRequest('invalid calendar entry id')
  const res = await c.db.prepare(`DELETE FROM holidays WHERE id = ?`).bind(id).run()
  if (!res.meta.changes) throw notFoundGo()
  return ok({ id, deleted: true })
}

// --- one day, read as a day (calendar_day.go) --------------------------------------------------------

async function getCalendarDay(c: Ctx) {
  let date = q(c, 'date')
  if (date === '') date = indiaToday()
  if (!isDate(date)) throw badRequest('date must be YYYY-MM-DD')
  const section = nullStr(q(c, 'section_id'))
  let teacher = nullStr(q(c, 'teacher_user_id'))
  if (section === null && teacher === null) teacher = c.id.userId
  const dow = isodow(date)
  const rows = await c.db.prepare(`
    SELECT p.id AS period_id, p.name, p.sequence, substr(p.starts_at,1,5) AS starts_at, substr(p.ends_at,1,5) AS ends_at, p.is_break,
           te.id AS entry_id, c.name AS class, sec.name AS section, sub.name AS subject, tu.full_name AS teacher, te.room,
           su.full_name AS substitute, sb.reason AS substitute_reason,
           lp.id AS lesson_id, COALESCE(lp.status,'') AS lesson_status, lp.week_of, lp.teaching_day, lp.objectives, lp.activities, lp.resources, lp.homework,
           lp.delivered_on, lp.file_id
      FROM periods p
      LEFT JOIN timetable_entries te ON te.period_id = p.id AND te.weekday = ? AND (? IS NULL OR te.section_id = ?) AND (? IS NULL OR te.teacher_user_id = ?)
      LEFT JOIN sections sec ON sec.id = te.section_id LEFT JOIN classes c ON c.id = sec.class_id
      LEFT JOIN class_subjects cs ON cs.id = te.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users tu ON tu.id = te.teacher_user_id
      LEFT JOIN substitutions sb ON sb.timetable_entry_id = te.id AND sb.on_date = ?
      LEFT JOIN users su ON su.id = sb.substitute_user_id
      LEFT JOIN lesson_plans lp ON lp.id = (SELECT l.id FROM lesson_plans l WHERE l.section_id = te.section_id AND l.class_subject_id = te.class_subject_id
                                              AND l.week_of BETWEEN ? AND ? AND (l.teaching_day IS NULL OR l.teaching_day = ?)
                                             ORDER BY l.week_of DESC, (l.teaching_day IS NULL), l.teaching_day LIMIT 1)
     WHERE p.is_break = 1 OR te.id IS NOT NULL
     ORDER BY p.sequence, c.name, sec.name`).bind(dow, section, section, teacher, teacher, date, addDays(date, -6), date, dow).all<Record<string, unknown>>()
  const periods = rows.results.map((v) => {
    const o: Record<string, unknown> = { period_id: v.period_id, name: v.name, sequence: v.sequence, starts_at: v.starts_at, ends_at: v.ends_at, is_break: bool(v.is_break) }
    for (const k of ['entry_id', 'class', 'section', 'subject', 'teacher', 'room', 'substitute', 'substitute_reason']) if (v[k] !== null) o[k] = v[k]
    if (v.lesson_id !== null) {
      o.lesson = omitNull({ id: v.lesson_id, status: v.lesson_status, week_of: v.week_of, teaching_day: v.teaching_day, objectives: v.objectives, activities: v.activities,
        resources: v.resources, homework: v.homework, delivered_on: v.delivered_on, file_id: v.file_id },
        ['week_of', 'teaching_day', 'objectives', 'activities', 'resources', 'homework', 'delivered_on', 'file_id'])
    }
    return o
  })
  const entries = (await calendarEntries(c, date, date, null, null)).map((e) => ({ ...e, campus: null }))
  entries.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
  let shut = false, working = false
  let reason: string | null = null
  for (const e of entries) {
    if (e.source !== 'calendar') continue
    if (e.kind === 'working_day') working = true
    else if ((e.kind === 'holiday' || e.kind === 'vacation') && (e.applies_to === 'all' || e.applies_to === 'students')) { shut = true; if (reason === null) reason = e.name }
  }
  const sunday = weekdayOf(date) === 0
  if (sunday && reason === null && !working) reason = 'Sunday'
  const open = working || (!sunday && !shut)
  if (open) reason = null
  let taught = 0, planned = 0
  for (const p of periods) { if (p.entry_id === undefined) continue; taught++; if (p.lesson) planned++ }
  return ok({ date, weekday: weekdayOf(date), open, reason, almanac: entries.map((e) => omitNull({ ...e }, ['description', 'campus'])), periods,
    summary: { periods_taught: taught, periods_planned: planned } })
}

// --- the year plan (year_plan.go) ------------------------------------------------------------------------

const MONTH_LABELS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

async function getYearPlan(c: Ctx) {
  const classSubject = q(c, 'class_subject_id')
  if (classSubject === '') throw badRequest('class_subject_id is required, a year plan is a plan for one subject in one class')
  let from: string, to: string
  try {
    const yearId = await workingYear(c)
    const y = await c.db.prepare(`SELECT starts_on, ends_on FROM academic_years WHERE id = ?`).bind(yearId).first<{ starts_on: string; ends_on: string }>()
    if (!y) throw new Error('no year')
    from = y.starts_on; to = y.ends_on
  } catch {
    from = academicYearStart(indiaToday()); to = `${Number(from.slice(0, 4)) + 1}-05-31`
  }
  const days = await markDays(c, from, to, true)
  const months: { month: string; label: string; working_days: number; exam_days: number; teaching_days: number }[] = []
  for (const [d, m] of days) {
    const key = d.slice(0, 7)
    let mo = months[months.length - 1]
    if (!mo || mo.month !== key) { mo = { month: key, label: MONTH_LABELS[Number(d.slice(5, 7)) - 1], working_days: 0, exam_days: 0, teaching_days: 0 }; months.push(mo) }
    if (!isOpen(d, m)) continue
    mo.working_days++
    if (m.examined) mo.exam_days++; else mo.teaching_days++
  }
  const rows = await c.db.prepare(`
    SELECT u.id, u.sequence, u.title, u.planned_periods,
           EXISTS (SELECT 1 FROM lesson_plan_units lpu JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id WHERE lpu.syllabus_unit_id = u.id AND lp.delivered_on IS NOT NULL) AS delivered,
           (SELECT max(lp.delivered_on) FROM lesson_plan_units lpu JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id WHERE lpu.syllabus_unit_id = u.id AND lp.delivered_on IS NOT NULL) AS delivered_on
      FROM syllabus_units u WHERE u.class_subject_id = ? AND u.is_active = 1 ORDER BY u.sequence, u.title`).bind(classSubject)
    .all<{ id: string; sequence: number; title: string; planned_periods: number; delivered: number; delivered_on: string | null }>()
  const units = rows.results.map((u) => {
    const o: Record<string, unknown> = { id: u.id, sequence: u.sequence, title: u.title, planned_periods: u.planned_periods, delivered: bool(u.delivered) }
    if (u.delivered_on !== null) o.delivered_on = u.delivered_on
    return o
  })
  let mi = 0, left = months.length > 0 ? months[0].teaching_days : 0
  let planned = 0, capacity = 0
  for (const m of months) capacity += m.teaching_days
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const need0 = rows.results[i].planned_periods
    planned += need0
    let need = need0
    const split: { month: string; periods: number }[] = []
    while (need > 0 && mi < months.length) {
      if (left === 0) { mi++; if (mi >= months.length) break; left = months[mi].teaching_days; continue }
      const take = Math.min(need, left)
      split.push({ month: months[mi].month, periods: take })
      if (!u.starts_in) u.starts_in = months[mi].month
      u.ends_in = months[mi].month
      need -= take; left -= take
    }
    if (split.length) u.split = split
    if (need > 0) u.overflows = true
  }
  const delivered = units.filter((u) => u.delivered).length
  return ok({ from, to, months, units, summary: { teaching_days: capacity, planned_periods: planned, spare_periods: capacity - planned, units: units.length, units_delivered: delivered } })
}

// --- the year plan importer (year_plan_import.go) -----------------------------------------------------------

const periodPat = /\(\s*(\d+)\s*[Pp]?\s*\)|(\d+)\s*\(\s*[Pp]\s*\)/
const roman: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 }
function gradeOf(s: string): number {
  s = s.trim().toLowerCase()
  if (s === '' || s === 'master') return 0
  for (const p of ['grade', 'class', 'g-', 'g ']) if (s.startsWith(p)) s = s.slice(p.length).trim()
  const head = s.split(/[ (-]/).filter(Boolean)
  if (head.length === 0) return 0
  const first = head[0]
  if (roman[first]) return roman[first]
  const m = first.match(/(\d+)/)
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 12) return n }
  return 0
}
const cleanTitle = (s: string) => s.replace(new RegExp(periodPat.source, 'g'), ' ').split(/\s+/).filter(Boolean).join(' ')
function periodsIn(s: string): number {
  const m = s.match(periodPat)
  if (!m) return 0
  for (const g of m.slice(1)) { if (!g) continue; const n = parseInt(g, 10); if (n > 0) return n }
  return 0
}

function parseCSVText(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false } else field += ch; continue }
    if (ch === '"') inQ = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

interface PlanSheet { subject: string; sheet: string; grade?: string; class_subject_id?: string; class_name?: string; subject_name?: string; why?: string; units: PlanUnit[]; planned_periods: number; applied?: boolean }

async function importYearPlan(c: Ctx) {
  const req = await readJSON<{ csv?: string; apply?: boolean }>(c.req)
  if (str(req.csv).trim() === '') throw badRequest('csv is required, export the workbook and send its text')
  const records = parseCSVText(str(req.csv))
  if (records.length < 2) throw badRequest('that file has no rows under its header')
  const head = records[0]
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())
  const iSubject = col('Subject'), iSheet = col('Sheet_Name')
  if (iSubject < 0 || iSheet < 0) throw badRequest('expected a Subject and a Sheet_Name column, this is the flattened export, one row per spreadsheet row')
  let iTopic = col('TOPICS'), iPeriods = -1
  head.forEach((h, i) => { const u = h.trim().toUpperCase(); if (u.includes('NUMBER') && h.toUpperCase().includes('PERIOD')) iPeriods = i })
  if (iTopic < 0) {
    outer: for (const rec of records.slice(1)) for (let i = 0; i < rec.length; i++) if (rec[i].trim().toUpperCase() === 'TOPICS') { iTopic = i; break outer }
  }
  if (iTopic < 0) throw badRequest('could not find the TOPICS column in that file')
  const at = (rec: string[], i: number) => (i < 0 || i >= rec.length ? '' : rec[i].trim())

  const order: string[] = []
  const sheets = new Map<string, PlanSheet>()
  const seen = new Map<string, Set<string>>()
  for (const rec of records.slice(1)) {
    const subject = at(rec, iSubject), sheet = at(rec, iSheet)
    if (subject === '' || sheet === '' || sheet.toUpperCase() === 'MASTER') continue
    const key = subject + '\x00' + sheet
    let ps = sheets.get(key)
    if (!ps) { ps = { subject, sheet, units: [], planned_periods: 0 }; sheets.set(key, ps); seen.set(key, new Set()); order.push(key) }
    const topic = at(rec, iTopic)
    if (topic === '' || topic.toUpperCase() === 'TOPICS') continue
    const title = cleanTitle(topic)
    const low = title.toLowerCase()
    if (title === '' || low.startsWith('y e a r') || low.startsWith('grade:') || low.startsWith('teacher') || low === 'bridge course' ||
      low.startsWith('bridge cours') || low.startsWith('bridge - cours') || low === 'revision') continue
    let periods = periodsIn(topic)
    if (periods === 0 && iPeriods >= 0) { const n = parseInt(at(rec, iPeriods), 10); if (n > 0) periods = n }
    if (seen.get(key)!.has(low)) {
      const u = ps.units.find((x) => x.title.toLowerCase() === low)
      if (u) { u.planned_periods = (u.planned_periods ?? 0) + periods; ps.planned_periods += periods }
      continue
    }
    seen.get(key)!.add(low)
    if (periods === 0) periods = 1
    ps.units.push({ title, planned_periods: periods })
    ps.planned_periods += periods
  }
  const catalogue = (await c.db.prepare(`SELECT cs.id, c.name AS class, sub.name AS subject FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id ORDER BY c.level, sub.name`)
    .all<{ id: string; class: string; subject: string }>()).results
  const matched: PlanSheet[] = [], unmatched: PlanSheet[] = []
  for (const key of order) {
    const ps = sheets.get(key)!
    if (ps.units.length === 0) { ps.why = 'no chapters on this sheet'; unmatched.push(ps); continue }
    const g = gradeOf(ps.sheet)
    if (g === 0) { ps.why = 'could not read a grade from the sheet name'; unmatched.push(ps); continue }
    ps.grade = String(g)
    const want = ps.subject.toLowerCase()
    const hit = catalogue.find((x) => gradeOf(x.class) === g && (x.subject.toLowerCase() === want || x.subject.toLowerCase().includes(want) || want.includes(x.subject.toLowerCase())))
    if (!hit) { ps.why = `this school has no ${ps.subject} in class ${ps.grade}`; unmatched.push(ps); continue }
    ps.class_subject_id = hit.id; ps.class_name = hit.class; ps.subject_name = hit.subject
    matched.push(ps)
  }
  let applied = 0
  if (req.apply && matched.length > 0) {
    const stmts: D1PreparedStatement[] = []
    for (const ps of matched) {
      const plan = await planReplaceSyllabusUnits(c, ps.class_subject_id!, ps.units.map((u) => ({ title: u.title, planned_periods: u.planned_periods })))
      stmts.push(...plan.stmts)
      ps.applied = true
      applied++
    }
    await batch(c, stmts)
  }
  const chapters = matched.reduce((n, ps) => n + ps.units.length, 0)
  return ok({ applied: !!req.apply, matched, unmatched, summary: { sheets_matched: matched.length, sheets_unmatched: unmatched.length, chapters, subjects_written: applied } })
}

// --- exams and marks monitoring ------------------------------------------------------------------------

async function getExamMonitor(c: Ctx) {
  const exam = nullStr(q(c, 'exam_id')), cls = nullStr(q(c, 'class_id')), year = nullStr(q(c, 'academic_year_id'))
  const rows = await c.db.prepare(`
    SELECT es.id AS exam_subject_id, e.id AS exam_id, e.name AS exam_name, e.kind AS exam_kind, c.name AS class_name, sub.name AS subject, es.exam_date,
           CAST(es.max_marks AS REAL) AS max_marks, CAST(es.pass_marks AS REAL) AS pass_marks,
           (SELECT group_concat(n, ', ') FROM (SELECT DISTINCT u.full_name AS n FROM section_subject_teachers sst JOIN users u ON u.id = sst.teacher_user_id WHERE sst.class_subject_id = cs.id)) AS teachers,
           (SELECT count(*) FROM enrollments en WHERE en.class_id = cs.class_id AND en.academic_year_id = e.academic_year_id AND en.status = 'active') AS eligible,
           count(m.id) AS entered,
           COALESCE(SUM(m.is_absent = 1), 0) AS absent,
           COALESCE(SUM(m.approved_at IS NOT NULL), 0) AS approved,
           COALESCE(SUM(m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND CAST(m.marks_obtained AS REAL) < CAST(es.pass_marks AS REAL)), 0) AS failed,
           COALESCE(ROUND(100.0 * AVG(CASE WHEN m.is_absent = 0 AND m.marks_obtained IS NOT NULL THEN CAST(m.marks_obtained AS REAL) END) / NULLIF(CAST(es.max_marks AS REAL), 0), 1), 0) AS average_percent,
           e.is_published AS published
      FROM exam_subjects es JOIN exams e ON e.id = es.exam_id JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id LEFT JOIN marks m ON m.exam_subject_id = es.id
     WHERE (? IS NULL OR e.id = ?) AND (? IS NULL OR cs.class_id = ?) AND (? IS NULL OR e.academic_year_id = ?)
     GROUP BY es.id ORDER BY e.name, c.level, sub.name LIMIT 500`).bind(exam, exam, cls, cls, year, year).all<Record<string, unknown>>()
  let papers = 0, complete = 0, signed = 0, pending = 0, backlogs = 0
  const items = rows.results.map((v) => {
    const eligible = Number(v.eligible), entered = Number(v.entered), approved = Number(v.approved)
    const pend = Math.max(eligible - entered, 0)
    const o = omitNull({ ...v, published: bool(v.published), pending: pend, complete: entered > 0 && pend === 0, signed_off: entered > 0 && approved >= entered,
      entry_percent: eligible > 0 ? Math.floor((entered * 100) / eligible) : 0 }, ['exam_date', 'teachers'])
    papers++; if (o.complete) complete++; if (o.signed_off) signed++; pending += pend; backlogs += Number(v.failed)
    return o
  })
  return ok({ items, summary: { papers, complete, signed_off: signed, marks_pending: pending, backlogs, complete_percent: papers === 0 ? 0 : Math.floor((complete * 100) / papers) } })
}

const TARGETS_SQL = `
  SELECT es.id,
         (SELECT count(*) FROM enrollments en WHERE en.class_id = cs.class_id AND en.academic_year_id = e.academic_year_id AND en.status = 'active') AS eligible,
         (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id) AS entered
    FROM exam_subjects es JOIN exams e ON e.id = es.exam_id JOIN class_subjects cs ON cs.id = es.class_subject_id
   WHERE (? IS NULL OR es.id = ?) AND (? IS NULL OR es.exam_id = ?)`

async function approveExamMarks(c: Ctx) {
  const req = await readJSON<{ exam_subject_id?: string; exam_id?: string }>(c.req)
  const es = nullStr(str(req.exam_subject_id)), ex = nullStr(str(req.exam_id))
  if (es === null && ex === null) throw badRequest('give an exam_subject_id or an exam_id')
  const counts = await c.db.prepare(`SELECT COALESCE(SUM(entered >= eligible AND entered > 0), 0) AS ready, COALESCE(SUM(entered < eligible OR entered = 0), 0) AS incomplete FROM (${TARGETS_SQL}) t`)
    .bind(es, es, ex, ex).first<{ ready: number; incomplete: number }>()
  if (!counts || counts.ready === 0) throw coded(409, 'marks_incomplete', 'every paper here still has marks missing. Chase the entry before signing it off')
  const res = await c.db.prepare(`UPDATE marks SET approved_by = ?, approved_at = ? WHERE approved_at IS NULL
      AND exam_subject_id IN (SELECT id FROM (${TARGETS_SQL}) t WHERE entered >= eligible AND entered > 0)`).bind(c.id.userId, now(), es, es, ex, ex).run()
  return ok({ papers_approved: counts.ready, papers_incomplete: counts.incomplete, marks_approved: res.meta.changes ?? 0 })
}

async function publishExamResults(c: Ctx) {
  const req = await readJSON<{ exam_id?: string; publish?: boolean | null }>(c.req)
  if (!isUUID(req.exam_id)) throw badRequest('exam_id must be a uuid')
  const publish = req.publish === undefined || req.publish === null || req.publish
  const e = await c.db.prepare(`SELECT e.name, (SELECT count(*) FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id WHERE es.exam_id = e.id) AS marks FROM exams e WHERE e.id = ?`)
    .bind(req.exam_id).first<{ name: string; marks: number }>()
  if (!e) throw notFoundGo()
  if (publish && e.marks === 0) throw coded(409, 'nothing_to_publish', `no marks have been entered for ${e.name} yet, so there is nothing to release`)
  await c.db.prepare(`UPDATE exams SET is_published = ?, published_at = ?, published_by = ? WHERE id = ?`)
    .bind(publish ? 1 : 0, publish ? now() : null, publish ? c.id.userId : null, req.exam_id).run()
  return ok({ exam_id: req.exam_id, published: publish, marks: e.marks })
}

// --- faculty allocation --------------------------------------------------------------------------------------

async function getFacultyAllocation(c: Ctx) {
  const unassigned = q(c, 'unassigned') === '1' || q(c, 'unassigned') === 'true'
  const year = nullStr(q(c, 'academic_year_id')), cls = nullStr(q(c, 'class_id')), teacher = nullStr(q(c, 'teacher_user_id'))
  const rows = await c.db.prepare(`
    SELECT sec.id AS section_id, sec.name AS section, c.id AS class_id, c.name AS class_name, cs.id AS class_subject_id, sub.name AS subject,
           sst.teacher_user_id, u.full_name AS teacher,
           (SELECT count(*) FROM timetable_entries te WHERE te.section_id = sec.id AND te.class_subject_id = cs.id) AS weekly_periods,
           EXISTS (SELECT 1 FROM timetable_entries te WHERE te.section_id = sec.id AND te.class_subject_id = cs.id AND te.teacher_user_id IS NOT NULL
                     AND te.teacher_user_id IS NOT sst.teacher_user_id) AS timetable_differs
      FROM sections sec JOIN classes c ON c.id = sec.class_id JOIN class_subjects cs ON cs.class_id = sec.class_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN section_subject_teachers sst ON sst.section_id = sec.id AND sst.class_subject_id = cs.id LEFT JOIN users u ON u.id = sst.teacher_user_id
     WHERE sec.academic_year_id = COALESCE(?, ${workingYearSQL()}, sec.academic_year_id)
       AND (? IS NULL OR sec.class_id = ?) AND (? IS NULL OR sst.teacher_user_id = ?) AND (NOT ? OR sst.id IS NULL)
     ORDER BY c.level, c.name, sec.name, sub.name LIMIT 1000`).bind(year, c.id.userId, cls, cls, teacher, teacher, unassigned ? 1 : 0).all<Record<string, unknown>>()
  let assigned = 0, conflicts = 0
  const teachers = new Set<string>()
  const items = rows.results.map((v) => {
    if (v.teacher_user_id !== null) { assigned++; teachers.add(String(v.teacher_user_id)) }
    if (bool(v.timetable_differs)) conflicts++
    return omitNull({ ...v, timetable_differs: bool(v.timetable_differs) }, ['teacher_user_id', 'teacher'])
  })
  return ok({ items, summary: { slots: items.length, assigned, unassigned: items.length - assigned, teachers_allocated: teachers.size, timetable_conflicts: conflicts } })
}

async function setFacultyAllocation(c: Ctx) {
  const req = await readJSON<{ allocations?: { section_id?: string; class_subject_id?: string; teacher_user_id?: string }[] }>(c.req)
  const allocs = req.allocations ?? []
  if (allocs.length === 0) throw badRequest('send at least one allocation')
  const stmts: D1PreparedStatement[] = []
  const clearing: number[] = []
  let assigned = 0
  for (const a of allocs) {
    if (!isUUID(a.section_id)) throw badRequest('section_id must be a uuid')
    if (!isUUID(a.class_subject_id)) throw badRequest('class_subject_id must be a uuid')
    if (str(a.teacher_user_id).trim() === '') {
      clearing.push(stmts.length)
      stmts.push(c.db.prepare(`DELETE FROM section_subject_teachers WHERE section_id = ? AND class_subject_id = ?`).bind(a.section_id, a.class_subject_id))
      continue
    }
    if (!isUUID(a.teacher_user_id)) throw badRequest('teacher_user_id must be a uuid')
    stmts.push(c.db.prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (section_id, class_subject_id) DO UPDATE SET teacher_user_id = excluded.teacher_user_id`)
      .bind(uuid(), inst(c), a.section_id, a.class_subject_id, a.teacher_user_id, now()))
    assigned++
  }
  let cleared = 0
  try {
    const res = await batch(c, stmts)
    for (const i of clearing) cleared += res[i].meta.changes ?? 0
  } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
  return ok({ assigned, cleared })
}

async function applyAllocationToTimetable(c: Ctx) {
  if (!c.id.institution) throw badRequest("this screen belongs to a school. Sign in against one, or pick a school first - a platform operator's account is not attached to any.")
  const res = await c.db.prepare(`
    UPDATE timetable_entries SET teacher_user_id = (SELECT t.teacher_user_id FROM section_subject_teachers t WHERE t.section_id = timetable_entries.section_id AND t.class_subject_id = timetable_entries.class_subject_id)
     WHERE EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.section_id = timetable_entries.section_id AND t.class_subject_id = timetable_entries.class_subject_id
                     AND timetable_entries.teacher_user_id IS NOT t.teacher_user_id)`).run()
  const without = await c.db.prepare(`SELECT count(*) AS n FROM section_subject_teachers t
     WHERE NOT EXISTS (SELECT 1 FROM timetable_entries te WHERE te.section_id = t.section_id AND te.class_subject_id = t.class_subject_id)`).first<{ n: number }>()
  return ok({ periods_reassigned: res.meta.changes ?? 0, allocations_with_no_period: without?.n ?? 0 })
}

// --- the substitution board ------------------------------------------------------------------------------------

const ABSENT_SQL = `
  SELECT u.id AS user_id, u.full_name, CASE WHEN sa.status IS NOT NULL THEN sa.status ELSE 'leave' END AS reason
    FROM users u JOIN employees e ON e.user_id = u.id
    LEFT JOIN staff_attendance sa ON sa.user_id = u.id AND sa.on_date = ? AND sa.status IN ('absent','leave')
   WHERE e.status IN ('active','on_leave')
     AND (sa.id IS NOT NULL OR EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved' AND ? BETWEEN lr.from_date AND lr.to_date))`

async function getSubstitutionBoard(c: Ctx) {
  const onDate = q(c, 'on_date') || indiaToday()
  const dow = isodow(onDate)
  const rows = await c.db.prepare(`
    WITH absent AS (${ABSENT_SQL})
    SELECT te.id AS timetable_entry_id, a.user_id AS absent_user_id, a.full_name AS absent_teacher, a.reason, p.name AS period, p.sequence AS period_sequence,
           substr(p.starts_at,1,5) AS starts_at, c.name AS class_name, sec.name AS section, sub.name AS subject,
           sb.substitute_user_id AS covered_by_user_id, su.full_name AS covered_by,
           (sb.substitute_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM absent a3 WHERE a3.user_id = sb.substitute_user_id)) AS cover_absent,
           (SELECT json_group_array(json_object('user_id', x.user_id, 'full_name', x.full_name, 'teaches_subject', x.teaches_subject, 'periods_today', x.periods_today))
              FROM (SELECT u2.id AS user_id, u2.full_name,
                           EXISTS (SELECT 1 FROM section_subject_teachers t2 JOIN class_subjects cs2 ON cs2.id = t2.class_subject_id WHERE t2.teacher_user_id = u2.id AND cs2.subject_id = cs.subject_id) AS teaches_subject,
                           (SELECT count(*) FROM timetable_entries t3 WHERE t3.teacher_user_id = u2.id AND t3.weekday = te.weekday) AS periods_today
                      FROM users u2 JOIN employees e2 ON e2.user_id = u2.id AND e2.status = 'active'
                     WHERE u2.id <> a.user_id AND NOT EXISTS (SELECT 1 FROM absent a2 WHERE a2.user_id = u2.id)
                       AND NOT EXISTS (SELECT 1 FROM timetable_entries t4 WHERE t4.teacher_user_id = u2.id AND t4.weekday = te.weekday AND t4.period_id = te.period_id)
                       AND NOT EXISTS (SELECT 1 FROM substitutions s2 JOIN timetable_entries t5 ON t5.id = s2.timetable_entry_id WHERE s2.substitute_user_id = u2.id AND s2.on_date = ? AND t5.period_id = te.period_id)
                     ORDER BY teaches_subject DESC, periods_today LIMIT 8) x) AS candidates
      FROM absent a JOIN timetable_entries te ON te.teacher_user_id = a.user_id AND te.weekday = ?
      JOIN periods p ON p.id = te.period_id JOIN sections sec ON sec.id = te.section_id JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN substitutions sb ON sb.timetable_entry_id = te.id AND sb.on_date = ? LEFT JOIN users su ON su.id = sb.substitute_user_id
     ORDER BY p.sequence, c.level, sec.name`).bind(onDate, onDate, onDate, dow, onDate).all<Record<string, unknown>>()
  const absentees = new Set<string>()
  let covered = 0, uncoverable = 0
  const items = rows.results.map((v) => {
    const candidates = parseJSON<{ user_id: string; full_name: string; teaches_subject: number; periods_today: number }[]>(v.candidates, [])
      .map((x) => ({ user_id: x.user_id, full_name: x.full_name, teaches_subject: bool(x.teaches_subject), periods_today: Number(x.periods_today) }))
      .sort((a, b) => (a.teaches_subject !== b.teaches_subject ? (a.teaches_subject ? -1 : 1) : a.periods_today - b.periods_today))
    absentees.add(String(v.absent_user_id))
    const coverAbsent = bool(v.cover_absent)
    if (v.covered_by_user_id !== null && !coverAbsent) covered++
    else if (candidates.length === 0) uncoverable++
    return omitNull({ ...v, cover_absent: coverAbsent, candidates }, ['covered_by', 'covered_by_user_id'])
  })
  const awayRows = await c.db.prepare(`
    SELECT u.id, u.full_name, CASE WHEN sa.id IS NOT NULL THEN sa.status ELSE 'on approved leave' END AS why
      FROM users u JOIN employees e ON e.user_id = u.id
      LEFT JOIN staff_attendance sa ON sa.user_id = u.id AND sa.on_date = ? AND sa.status IN ('absent','leave')
     WHERE e.status IN ('active','on_leave')
       AND (sa.id IS NOT NULL OR EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved' AND ? BETWEEN lr.from_date AND lr.to_date))
     ORDER BY u.full_name`).bind(onDate, onDate).all<{ id: string; full_name: string; why: string }>()
  const away = awayRows.results.map((r) => {
    const hasPeriods = absentees.has(r.id)
    absentees.add(r.id)
    return { user_id: r.id, full_name: r.full_name, reason: r.why, periods_today: hasPeriods }
  })
  return ok({ items, on_date: onDate, away, summary: { absent_teachers: absentees.size, periods: items.length, covered, uncovered: items.length - covered, no_candidate: uncoverable } })
}

// --- OBE / outcomes -------------------------------------------------------------------------------------------------

const MAPPED_TO_SQL = `(SELECT json_group_array(code) FROM (SELECT po.code FROM co_po_map m JOIN programme_outcomes po ON po.id = m.programme_outcome_id WHERE m.course_outcome_id = co.id ORDER BY upper(po.code)))`

async function getOutcomes(c: Ctx) {
  const cs = nullStr(q(c, 'class_subject_id'))
  const [pos, cos] = await batch(c, [
    c.db.prepare(`SELECT id, code, statement, kind, sequence FROM programme_outcomes ORDER BY kind, sequence, upper(code)`),
    c.db.prepare(`
      SELECT co.id, cs.id AS class_subject_id, c.name AS class_name, sub.name AS subject, co.code, co.statement, co.bloom_level, co.threshold_percent, co.target_percent, co.sequence,
             ${MAPPED_TO_SQL} AS mapped_to, (SELECT count(*) FROM outcome_assessments oa WHERE oa.course_outcome_id = co.id) AS papers
        FROM course_outcomes co JOIN class_subjects cs ON cs.id = co.class_subject_id JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
       WHERE (? IS NULL OR co.class_subject_id = ?) ORDER BY c.level, sub.name, co.sequence, upper(co.code)`).bind(cs, cs),
  ])
  return ok({
    programme_outcomes: pos.results,
    course_outcomes: (cos.results as Record<string, unknown>[]).map((v) => omitNull({ ...v, mapped_to: parseJSON<string[]>(v.mapped_to, []) }, ['bloom_level'])),
  })
}

async function getOutcomeAttainment(c: Ctx) {
  const cs = nullStr(q(c, 'class_subject_id'))
  const rows = await c.db.prepare(`
    SELECT co.id AS course_outcome_id, co.code, co.statement, c.name AS class_name, sub.name AS subject, cs.id AS class_subject_id,
           co.threshold_percent, co.target_percent,
           (SELECT count(*) FROM outcome_assessments oa WHERE oa.course_outcome_id = co.id) AS papers,
           COALESCE(a.assessed, 0) AS assessed, COALESCE(a.cleared, 0) AS cleared, ${MAPPED_TO_SQL} AS mapped_to
      FROM course_outcomes co JOIN class_subjects cs ON cs.id = co.class_subject_id JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN (
        SELECT scores.course_outcome_id, count(*) AS assessed, SUM(scores.pct >= scores.threshold) AS cleared
          FROM (SELECT oa.course_outcome_id, m.student_id, co2.threshold_percent AS threshold,
                       100.0 * SUM(CAST(m.marks_obtained AS REAL) * CAST(oa.weight AS REAL) / 100.0) / NULLIF(SUM(CAST(es.max_marks AS REAL) * CAST(oa.weight AS REAL) / 100.0), 0) AS pct
                  FROM outcome_assessments oa JOIN course_outcomes co2 ON co2.id = oa.course_outcome_id
                  JOIN exam_subjects es ON es.id = oa.exam_subject_id
                  JOIN marks m ON m.exam_subject_id = es.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL
                 GROUP BY oa.course_outcome_id, m.student_id) scores
         GROUP BY scores.course_outcome_id) a ON a.course_outcome_id = co.id
     WHERE (? IS NULL OR co.class_subject_id = ?) ORDER BY c.level, sub.name, co.sequence, upper(co.code)`).bind(cs, cs).all<Record<string, unknown>>()
  const items = rows.results.map((v) => {
    const assessed = Number(v.assessed), cleared = Number(v.cleared), target = Number(v.target_percent)
    let attainment = 0, attained = false, gap = 0
    if (assessed > 0) { attainment = Math.floor((cleared * 100) / assessed); attained = attainment >= target; if (!attained) gap = target - attainment }
    return { ...v, course_outcome_id: String(v.course_outcome_id), assessed, cleared, attainment_percent: attainment, attained, gap, mapped_to: parseJSON<string[]>(v.mapped_to, []) }
  })
  const links = await c.db.prepare(`SELECT po.code, po.statement, m.course_outcome_id, m.strength FROM co_po_map m JOIN programme_outcomes po ON po.id = m.programme_outcome_id ORDER BY upper(po.code)`)
    .all<{ code: string; statement: string; course_outcome_id: string; strength: number }>()
  const byId = new Map(items.map((i) => [String(i.course_outcome_id), i]))
  const byCode = new Map<string, { statement: string; sum: number; wgt: number; outcomes: number }>()
  for (const l of links.results) {
    const co = byId.get(l.course_outcome_id)
    if (!co || co.assessed === 0) continue
    let w = byCode.get(l.code)
    if (!w) { w = { statement: l.statement, sum: 0, wgt: 0, outcomes: 0 }; byCode.set(l.code, w) }
    w.sum += co.attainment_percent * l.strength; w.wgt += l.strength; w.outcomes++
  }
  const programme = [...byCode.entries()].map(([code, w]) => ({ code, statement: w.statement, course_outcomes: w.outcomes,
    attainment_percent: w.wgt > 0 ? Math.floor(w.sum / w.wgt) : 0, measured: w.wgt > 0 })).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  let measured = 0, attained = 0
  for (const it of items) if (it.assessed > 0) { measured++; if (it.attained) attained++ }
  return ok({ items, programme, summary: { course_outcomes: items.length, measured, attained, not_measured: items.length - measured } })
}

async function saveProgrammeOutcome(c: Ctx) {
  const req = await readJSON<{ id?: string; code?: string; statement?: string; kind?: string; sequence?: number }>(c.req)
  const code = str(req.code).trim(), statement = str(req.statement).trim()
  if (code === '' || statement === '') throw badRequest('code and statement are both required')
  const kind = req.kind || 'po'
  if (kind !== 'po' && kind !== 'pso') throw badRequest('kind must be po or pso')
  const seq = req.sequence && req.sequence > 0 ? req.sequence : 1
  if (req.id) {
    const res = await c.db.prepare(`UPDATE programme_outcomes SET code = ?, statement = ?, kind = ?, sequence = ? WHERE id = ?`).bind(code, statement, kind, seq, req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  const existing = await c.db.prepare(`SELECT id FROM programme_outcomes WHERE institution_id = ? AND upper(code) = upper(?)`).bind(inst(c), code).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE programme_outcomes SET statement = ?, kind = ?, sequence = ? WHERE id = ?`).bind(statement, kind, seq, existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO programme_outcomes (id, institution_id, code, statement, kind, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, inst(c), code, statement, kind, seq, now()).run()
  return ok({ id })
}

async function saveCourseOutcome(c: Ctx) {
  const req = await readJSON<{ id?: string; class_subject_id?: string; code?: string; statement?: string; bloom_level?: string; threshold_percent?: number; target_percent?: number; sequence?: number }>(c.req)
  if (!isUUID(req.class_subject_id)) throw badRequest('class_subject_id must be a uuid')
  const code = str(req.code).trim(), statement = str(req.statement).trim()
  if (code === '' || statement === '') throw badRequest('code and statement are both required')
  let threshold = req.threshold_percent ?? 0, target = req.target_percent ?? 0
  if (threshold <= 0 || threshold > 100) threshold = 50
  if (target <= 0 || target > 100) target = 60
  const seq = req.sequence && req.sequence > 0 ? req.sequence : 1
  const bloom = nullStr(str(req.bloom_level))
  if (req.id) {
    const res = await c.db.prepare(`UPDATE course_outcomes SET code = ?, statement = ?, bloom_level = ?, threshold_percent = ?, target_percent = ?, sequence = ? WHERE id = ?`)
      .bind(code, statement, bloom, threshold, target, seq, req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  const existing = await c.db.prepare(`SELECT id FROM course_outcomes WHERE class_subject_id = ? AND upper(code) = upper(?)`).bind(req.class_subject_id, code).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE course_outcomes SET statement = ?, bloom_level = ?, threshold_percent = ?, target_percent = ?, sequence = ? WHERE id = ?`)
      .bind(statement, bloom, threshold, target, seq, existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO course_outcomes (id, institution_id, class_subject_id, code, statement, bloom_level, threshold_percent, target_percent, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), req.class_subject_id, code, statement, bloom, threshold, target, seq, now()).run()
  return ok({ id })
}

async function setOutcomeMapping(c: Ctx) {
  const req = await readJSON<{ course_outcome_id?: string; programme_map?: { programme_outcome_id?: string; strength?: number }[]; assessments?: { exam_subject_id?: string; weight?: number }[] }>(c.req)
  if (!isUUID(req.course_outcome_id)) throw badRequest('course_outcome_id must be a uuid')
  const exists = await c.db.prepare(`SELECT 1 AS ok FROM course_outcomes WHERE id = ?`).bind(req.course_outcome_id).first()
  if (!exists) throw notFoundGo()
  const stmts: D1PreparedStatement[] = [c.db.prepare(`DELETE FROM co_po_map WHERE course_outcome_id = ?`).bind(req.course_outcome_id)]
  let mapped = 0, assessed = 0
  for (const m of req.programme_map ?? []) {
    if (!isUUID(m.programme_outcome_id)) throw badRequest('programme_outcome_id must be a uuid')
    let strength = m.strength ?? 1
    if (strength < 1 || strength > 3) strength = 1
    stmts.push(c.db.prepare(`INSERT INTO co_po_map (id, institution_id, course_outcome_id, programme_outcome_id, strength) VALUES (?, ?, ?, ?, ?)`)
      .bind(uuid(), inst(c), req.course_outcome_id, m.programme_outcome_id, strength))
    mapped++
  }
  stmts.push(c.db.prepare(`DELETE FROM outcome_assessments WHERE course_outcome_id = ?`).bind(req.course_outcome_id))
  for (const a of req.assessments ?? []) {
    if (!isUUID(a.exam_subject_id)) throw badRequest('exam_subject_id must be a uuid')
    let weight = a.weight ?? 0
    if (weight <= 0 || weight > 100) weight = 100
    stmts.push(c.db.prepare(`INSERT INTO outcome_assessments (id, institution_id, course_outcome_id, exam_subject_id, weight) VALUES (?, ?, ?, ?, ?)`)
      .bind(uuid(), inst(c), req.course_outcome_id, a.exam_subject_id, String(weight)))
    assessed++
  }
  try { await batch(c, stmts) } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
  return ok({ programme_outcomes_mapped: mapped, papers_mapped: assessed })
}

// --- department students -----------------------------------------------------------------------------------------------

async function getDepartmentStudents(c: Ctx) {
  const dept = nullStr(q(c, 'department_id')), cls = nullStr(q(c, 'class_id')), search = nullStr(q(c, 'q'))
  const [depts, students] = await batch(c, [
    c.db.prepare(`
      SELECT d.id, d.name, u.full_name AS head,
             (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS staff,
             (SELECT count(DISTINCT en.student_id) FROM employees e JOIN section_subject_teachers sst ON sst.teacher_user_id = e.user_id
               JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active' WHERE e.department_id = d.id) AS students,
             (SELECT count(DISTINCT sst.section_id) FROM employees e JOIN section_subject_teachers sst ON sst.teacher_user_id = e.user_id WHERE e.department_id = d.id) AS sections
        FROM departments d LEFT JOIN users u ON u.id = d.head_user_id WHERE (? IS NULL OR d.id = ?) ORDER BY d.name`).bind(dept, dept),
    c.db.prepare(`
      WITH roll AS (
        SELECT DISTINCT d.name AS department, en.id AS enrollment_id
          FROM departments d JOIN employees e ON e.department_id = d.id AND e.user_id IS NOT NULL
          JOIN section_subject_teachers sst ON sst.teacher_user_id = e.user_id
          JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active'
         WHERE (? IS NULL OR d.id = ?))
      SELECT st.id AS student_id, st.admission_no, ${fullName('st')} AS full_name, c.name AS class_name, sec.name AS section, en.roll_no, roll.department,
             ct.full_name AS advisor,
             (SELECT CAST(ROUND(100.0 * SUM(sa.status IN ('present','late')) / NULLIF(count(*), 0)) AS INTEGER) FROM student_attendance sa WHERE sa.student_id = st.id) AS attendance_percent,
             (SELECT CASE WHEN SUM(CAST(es.max_marks AS REAL)) > 0 THEN ROUND(100.0 * SUM(CAST(m.marks_obtained AS REAL)) / SUM(CAST(es.max_marks AS REAL)), 1) END
                FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id WHERE m.student_id = st.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL) AS marks_percent,
             COALESCE((SELECT SUM(CAST(m.marks_obtained AS REAL) < CAST(es.pass_marks AS REAL)) FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id
                        WHERE m.student_id = st.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL), 0) AS backlogs
        FROM roll JOIN enrollments en ON en.id = roll.enrollment_id JOIN students st ON st.id = en.student_id
        JOIN sections sec ON sec.id = en.section_id JOIN classes c ON c.id = en.class_id LEFT JOIN users ct ON ct.id = sec.class_teacher_id
       WHERE st.status = 'active' AND (? IS NULL OR en.class_id = ?)
         AND (? IS NULL OR st.admission_no LIKE ? ESCAPE '\\' OR ${fullName('st')} LIKE ? ESCAPE '\\')
       ORDER BY roll.department, c.level, sec.name, st.first_name LIMIT 600`).bind(dept, dept, cls, cls, search, like(search ?? ''), like(search ?? '')),
  ])
  const items = (students.results as Record<string, unknown>[]).map((v) => omitNull({ ...v }, ['roll_no', 'advisor', 'attendance_percent', 'marks_percent']))
  const withBacklogs = items.filter((i) => Number(i.backlogs) > 0).length
  return ok({ items, departments: (depts.results as Record<string, unknown>[]).map((d) => omitNull({ ...d }, ['head'])),
    summary: { departments: depts.results.length, students: items.length, with_backlogs: withBacklogs } })
}

// --- the disciplinary incident log ---------------------------------------------------------------------------------------

async function listIncidents(c: Ctx) {
  const [from, to] = adminWindow(c)
  const status = nullStr(q(c, 'status')), severity = nullStr(q(c, 'severity')), student = nullStr(q(c, 'student_id'))
  const concernsOnly = q(c, 'concerns_only') === '1' ? 1 : 0
  const today = indiaToday()
  const rows = await c.db.prepare(`
    SELECT dr.id, dr.student_id, ${fullName('st')} AS student_name, st.admission_no, c.name AS class_name, sec.name AS section, dr.occurred_on, dr.category, dr.is_positive,
           dr.severity, dr.status, dr.description, dr.action_taken, dr.follow_up_on, dr.suspension_from, dr.suspension_to,
           COALESCE(CAST(julianday(dr.suspension_to) - julianday(dr.suspension_from) AS INTEGER) + 1, 0) AS suspension_days,
           dr.parent_meeting_on, dr.parent_meeting_note, dr.counselling_note, dr.parent_notified, dr.closed_on, ru.full_name AS recorded_by, cu.full_name AS closed_by,
           MAX(0, CAST(julianday(?) - julianday(dr.occurred_on) AS INTEGER)) AS age_days,
           (SELECT count(*) FROM discipline_records p WHERE p.student_id = dr.student_id AND p.is_positive = 0 AND p.occurred_on < dr.occurred_on) AS prior_incidents
      FROM discipline_records dr JOIN students st ON st.id = dr.student_id ${CUR_ENROLMENT}
      LEFT JOIN users ru ON ru.id = dr.recorded_by LEFT JOIN users cu ON cu.id = dr.closed_by
     WHERE dr.occurred_on BETWEEN ? AND ? AND (? IS NULL OR dr.status = ?) AND (? IS NULL OR dr.severity = ?) AND (? IS NULL OR dr.student_id = ?)
       AND (NOT ? OR dr.is_positive = 0)
     ORDER BY dr.occurred_on DESC, dr.created_at DESC LIMIT 400`)
    .bind(today, from, to, status, status, severity, severity, student, student, concernsOnly).all<Record<string, unknown>>()
  let open = 0, serious = 0, suspensions = 0, meetings = 0
  const items = rows.results.map((v) => {
    if (v.status !== 'closed' && !bool(v.is_positive)) open++
    if (v.severity === 'serious') serious++
    if (Number(v.suspension_days) > 0) suspensions++
    if (v.parent_meeting_on !== null) meetings++
    return omitNull({ ...v, is_positive: bool(v.is_positive), parent_notified: bool(v.parent_notified) },
      ['class_name', 'section', 'action_taken', 'follow_up_on', 'suspension_from', 'suspension_to', 'parent_meeting_on', 'parent_meeting_note', 'counselling_note', 'closed_on', 'recorded_by', 'closed_by'])
  })
  return ok({ items, from, to, summary: { incidents: items.length, open, serious, suspensions, parent_meetings: meetings } })
}

const incidentSeverities = new Set(['minor', 'major', 'serious'])
const incidentStatuses = new Set(['open', 'under_review', 'action_taken', 'closed'])

async function updateIncident(c: Ctx) {
  const id = c.params.id
  if (!isUUID(id)) throw badRequest('invalid incident id')
  const req = await readJSON<{ severity?: string; status?: string; action_taken?: string; follow_up_on?: string; suspension_from?: string; suspension_to?: string
    parent_meeting_on?: string; parent_meeting_note?: string; counselling_note?: string; parent_notified?: boolean | null }>(c.req)
  if (req.severity && !incidentSeverities.has(req.severity)) throw badRequest('severity must be minor, major or serious')
  if (req.status && !incidentStatuses.has(req.status)) throw badRequest('status must be open, under_review, action_taken or closed')
  if (req.suspension_from && req.suspension_to && req.suspension_to < req.suspension_from) throw badRequest('the suspension ends before it starts')
  if (req.status === 'closed' && str(req.action_taken).trim() === '') {
    const row = await c.db.prepare(`SELECT (COALESCE(trim(action_taken), '') <> '') AS recorded FROM discipline_records WHERE id = ?`).bind(id).first<{ recorded: number }>()
    if (!row) throw notFoundGo()
    if (!row.recorded) throw badRequest('say what was done before closing it. A closed incident with no action recorded answers nothing later')
  }
  const status = str(req.status)
  const notified = req.parent_notified === undefined || req.parent_notified === null ? null : req.parent_notified ? 1 : 0
  const res = await c.db.prepare(`
    UPDATE discipline_records SET severity = COALESCE(?, severity), status = COALESCE(?, status), action_taken = COALESCE(?, action_taken),
           follow_up_on = COALESCE(?, follow_up_on), suspension_from = COALESCE(?, suspension_from), suspension_to = COALESCE(?, suspension_to),
           parent_meeting_on = COALESCE(?, parent_meeting_on), parent_meeting_note = COALESCE(?, parent_meeting_note), counselling_note = COALESCE(?, counselling_note),
           parent_notified = COALESCE(?, parent_notified),
           closed_on = CASE WHEN ? = 'closed' THEN COALESCE(closed_on, ?) WHEN ? <> '' THEN NULL ELSE closed_on END,
           closed_by = CASE WHEN ? = 'closed' THEN COALESCE(closed_by, ?) WHEN ? <> '' THEN NULL ELSE closed_by END
     WHERE id = ?`).bind(nullStr(str(req.severity)), nullStr(status), nullStr(str(req.action_taken)), nullStr(str(req.follow_up_on)), nullStr(str(req.suspension_from)),
      nullStr(str(req.suspension_to)), nullStr(str(req.parent_meeting_on)), nullStr(str(req.parent_meeting_note)), nullStr(str(req.counselling_note)), notified,
      status, indiaToday(), status, status, c.id.userId, status, id).run()
  if (!res.meta.changes) throw notFoundGo()
  return ok({ id })
}

// --- the student council ----------------------------------------------------------------------------------------------------

async function getCouncil(c: Ctx) {
  const yearId = nullStr(q(c, 'academic_year_id'))
  const resolveYear = `COALESCE(?, ${workingYearSQL()}, (SELECT academic_year_id FROM council_positions ORDER BY created_at DESC LIMIT 1))`
  const [positions, members] = await batch(c, [
    c.db.prepare(`
      SELECT cp.id, cp.academic_year_id, ay.name AS academic_year, cp.title, cp.portfolio, cp.seats, cp.is_elected, cp.sequence, cp.description,
             (SELECT count(*) FROM council_members cm WHERE cm.position_id = cp.id AND cm.status = 'serving') AS filled
        FROM council_positions cp JOIN academic_years ay ON ay.id = cp.academic_year_id
       WHERE cp.academic_year_id = ${resolveYear} ORDER BY cp.sequence, lower(cp.title)`).bind(yearId, c.id.userId),
    c.db.prepare(`
      SELECT cm.id, cp.id AS position_id, cp.title AS position, st.id AS student_id, ${fullName('st')} AS student_name, st.admission_no, c.name AS class_name, sec.name AS section,
             cm.elected_on, cm.term_from, cm.term_to, cm.votes, cm.status, cm.remarks,
             (SELECT count(*) FROM council_duties cd WHERE cd.member_id = cm.id) AS duties,
             (SELECT count(*) FROM council_duties cd WHERE cd.member_id = cm.id AND cd.performed = 1) AS duties_done
        FROM council_members cm JOIN council_positions cp ON cp.id = cm.position_id JOIN students st ON st.id = cm.student_id ${CUR_ENROLMENT}
       WHERE cp.academic_year_id = ${resolveYear} ORDER BY cp.sequence, cm.status, st.first_name`).bind(yearId, c.id.userId),
  ])
  let seats = 0, vacancies = 0, duties = 0, done = 0
  const pos = (positions.results as Record<string, unknown>[]).map((p) => {
    const vac = Math.max(Number(p.seats) - Number(p.filled), 0)
    seats += Number(p.seats); vacancies += vac
    return omitNull({ ...p, is_elected: bool(p.is_elected), vacancies: vac }, ['portfolio', 'description'])
  })
  const mem = (members.results as Record<string, unknown>[]).map((m) => {
    duties += Number(m.duties); done += Number(m.duties_done)
    return omitNull({ ...m }, ['class_name', 'section', 'elected_on', 'term_to', 'votes', 'remarks'])
  })
  return ok({ positions: pos, members: mem, summary: { positions: pos.length, seats, vacancies, serving: mem.length, duties, duties_done: done } })
}

async function saveCouncilPosition(c: Ctx) {
  const req = await readJSON<{ id?: string; academic_year_id?: string; title?: string; portfolio?: string; seats?: number; is_elected?: boolean | null; sequence?: number; description?: string }>(c.req)
  const title = str(req.title).trim()
  if (title === '') throw badRequest('give the post a title')
  const seats = req.seats && req.seats > 0 ? req.seats : 1
  const seq = req.sequence && req.sequence > 0 ? req.sequence : 1
  const elected = req.is_elected === undefined || req.is_elected === null ? 1 : req.is_elected ? 1 : 0
  if (req.id) {
    const res = await c.db.prepare(`UPDATE council_positions SET title = ?, portfolio = ?, seats = ?, is_elected = ?, sequence = ?, description = ? WHERE id = ?`)
      .bind(title, nullStr(str(req.portfolio)), seats, elected, seq, nullStr(str(req.description)), req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  const year = await workingYear(c, str(req.academic_year_id))
  const existing = await c.db.prepare(`SELECT id FROM council_positions WHERE academic_year_id = ? AND lower(title) = lower(?)`).bind(year, title).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE council_positions SET portfolio = ?, seats = ?, is_elected = ?, sequence = ?, description = ? WHERE id = ?`)
      .bind(nullStr(str(req.portfolio)), seats, elected, seq, nullStr(str(req.description)), existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO council_positions (id, institution_id, academic_year_id, title, portfolio, seats, is_elected, sequence, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), year, title, nullStr(str(req.portfolio)), seats, elected, seq, nullStr(str(req.description)), now()).run()
  return ok({ id })
}

async function saveCouncilMember(c: Ctx) {
  const req = await readJSON<{ id?: string; position_id?: string; student_id?: string; elected_on?: string; term_from?: string; term_to?: string; votes?: number | null; status?: string; remarks?: string }>(c.req)
  if (!isUUID(req.position_id)) throw badRequest('position_id must be a uuid')
  if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
  const status = req.status || 'serving'
  if (!['serving', 'completed', 'resigned', 'removed'].includes(status)) throw badRequest('status must be serving, completed, resigned or removed')
  const votes = req.votes ?? null
  if (req.id) {
    const res = await c.db.prepare(`UPDATE council_members SET elected_on = ?, term_to = ?, votes = ?, status = ?, remarks = ? WHERE id = ?`)
      .bind(nullStr(str(req.elected_on)), nullStr(str(req.term_to)), votes, status, nullStr(str(req.remarks)), req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  if (status === 'serving') {
    const full = await c.db.prepare(`SELECT ((SELECT count(*) FROM council_members cm WHERE cm.position_id = ? AND cm.status = 'serving') >= (SELECT seats FROM council_positions WHERE id = ?)) AS full`)
      .bind(req.position_id, req.position_id).first<{ full: number }>()
    if (bool(full?.full)) throw coded(409, 'position_full', "every seat on that post is taken. Raise the seat count or end somebody's term first")
  }
  const termFrom = nullStr(str(req.term_from)) ?? indiaToday()
  const existing = await c.db.prepare(`SELECT id FROM council_members WHERE position_id = ? AND student_id = ? AND term_from = ?`).bind(req.position_id, req.student_id, termFrom).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE council_members SET elected_on = ?, term_to = ?, votes = ?, status = ?, remarks = ? WHERE id = ?`)
      .bind(nullStr(str(req.elected_on)), nullStr(str(req.term_to)), votes, status, nullStr(str(req.remarks)), existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  try {
    await c.db.prepare(`INSERT INTO council_members (id, institution_id, position_id, student_id, elected_on, term_from, term_to, votes, status, remarks, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), req.position_id, req.student_id, nullStr(str(req.elected_on)), termFrom, nullStr(str(req.term_to)), votes, status, nullStr(str(req.remarks)), c.id.userId, now()).run()
  } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
  return ok({ id })
}

async function saveCouncilDuty(c: Ctx) {
  const req = await readJSON<{ member_id?: string; on_date?: string; duty?: string; notes?: string; performed?: boolean }>(c.req)
  if (!isUUID(req.member_id)) throw badRequest('member_id must be a uuid')
  const duty = str(req.duty).trim()
  if (duty === '') throw badRequest('say what the duty was, "she was head girl" is worth nothing in a testimonial and "she ran the assembly rota" is')
  const id = uuid()
  try {
    await c.db.prepare(`INSERT INTO council_duties (id, institution_id, member_id, on_date, duty, notes, performed, recorded_by, created_at) VALUES (?, ?, ?, COALESCE(?, ?), ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), req.member_id, nullStr(str(req.on_date)), indiaToday(), duty, nullStr(str(req.notes)), req.performed ? 1 : 0, c.id.userId, now()).run()
  } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
  return created({ id })
}

// --- the alumni programme -----------------------------------------------------------------------------------------------------

/** The leaving year: June to April, so a March leaver belongs to the year that began the previous June. */
const BATCH_YEAR_SQL = (col: string) => `CASE WHEN CAST(strftime('%m', COALESCE(${col}, ?)) AS INTEGER) < 6 THEN CAST(strftime('%Y', COALESCE(${col}, ?)) AS INTEGER) - 1
                                           ELSE CAST(strftime('%Y', COALESCE(${col}, ?)) AS INTEGER) END`

async function getAlumni(c: Ctx) {
  const batchRaw = q(c, 'batch_year')
  const batchYear = batchRaw === '' || !Number.isInteger(Number(batchRaw)) ? null : Number(batchRaw)
  const search = nullStr(q(c, 'q'))
  const today = indiaToday()
  const [items, candidates] = await batch(c, [
    c.db.prepare(`
      SELECT ap.id, st.id AS student_id, st.admission_no, ${fullName('st')} AS full_name, ap.batch_year, ap.occupation, ap.employer, ap.higher_study, ap.city, ap.country,
             ap.email, ap.phone, ap.contactable, ap.notes,
             (SELECT count(*) FROM alumni_event_rsvps re WHERE re.alumni_profile_id = ap.id AND re.attended = 1) AS events_attended,
             COALESCE((SELECT sum(ac.amount_paise) FROM alumni_contributions ac WHERE ac.alumni_profile_id = ap.id), 0) AS contributed_paise,
             (SELECT max(ac.received_on) FROM alumni_contributions ac WHERE ac.alumni_profile_id = ap.id) AS last_contribution_on
        FROM alumni_profiles ap JOIN students st ON st.id = ap.student_id
       WHERE (? IS NULL OR ap.batch_year = ?)
         AND (? IS NULL OR st.admission_no LIKE ? ESCAPE '\\' OR ${fullName('st')} LIKE ? ESCAPE '\\' OR COALESCE(ap.employer,'') LIKE ? ESCAPE '\\' OR COALESCE(ap.occupation,'') LIKE ? ESCAPE '\\')
       ORDER BY ap.batch_year DESC, st.first_name LIMIT 500`).bind(batchYear, batchYear, search, like(search ?? ''), like(search ?? ''), like(search ?? ''), like(search ?? '')),
    c.db.prepare(`
      SELECT st.id AS student_id, st.admission_no, ${fullName('st')} AS full_name, st.status, st.exit_date AS left_on, ${BATCH_YEAR_SQL('st.exit_date')} AS batch_year
        FROM students st WHERE st.status IN ('graduated','alumni') AND NOT EXISTS (SELECT 1 FROM alumni_profiles ap WHERE ap.student_id = st.id)
       ORDER BY (st.exit_date IS NULL), st.exit_date DESC, st.first_name LIMIT 200`).bind(today, today, today),
  ])
  let total = 0, contactable = 0
  const batches = new Set<number>()
  const list = (items.results as Record<string, unknown>[]).map((v) => {
    total += Number(v.contributed_paise); if (bool(v.contactable)) contactable++; batches.add(Number(v.batch_year))
    return omitNull({ ...v, contactable: bool(v.contactable) }, ['occupation', 'employer', 'higher_study', 'city', 'email', 'phone', 'notes', 'last_contribution_on'])
  })
  return ok({ items: list, candidates: (candidates.results as Record<string, unknown>[]).map((v) => omitNull({ ...v }, ['left_on'])),
    summary: { alumni: list.length, batches: batches.size, contactable, not_yet_enrolled: candidates.results.length, contributed_paise: total } })
}

async function listAlumniEvents(c: Ctx) {
  const status = nullStr(q(c, 'status'))
  const rows = await c.db.prepare(`
    SELECT ae.id, ae.title, ae.on_date, ae.venue, ae.description, ae.expected, ae.status,
           (SELECT count(*) FROM alumni_event_rsvps re WHERE re.event_id = ae.id) AS invited,
           (SELECT count(*) FROM alumni_event_rsvps re WHERE re.event_id = ae.id AND re.rsvp = 'yes') AS accepted,
           (SELECT count(*) FROM alumni_event_rsvps re WHERE re.event_id = ae.id AND re.attended = 1) AS attended,
           COALESCE((SELECT sum(re.guests) FROM alumni_event_rsvps re WHERE re.event_id = ae.id AND re.attended = 1), 0) AS guests,
           COALESCE((SELECT sum(ac.amount_paise) FROM alumni_contributions ac WHERE ac.event_id = ae.id), 0) AS raised_paise, ay.name AS academic_year
      FROM alumni_events ae LEFT JOIN academic_years ay ON ay.id = ae.academic_year_id
     WHERE (? IS NULL OR ae.status = ?) ORDER BY ae.on_date DESC LIMIT 200`).bind(status, status).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v }, ['venue', 'description', 'expected', 'academic_year'])) })
}

async function saveAlumniProfile(c: Ctx) {
  const req = await readJSON<{ id?: string; student_id?: string; batch_year?: number; occupation?: string; employer?: string; higher_study?: string; city?: string; country?: string
    email?: string; phone?: string; contactable?: boolean | null; notes?: string }>(c.req)
  if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
  const batchYear = req.batch_year ?? 0
  if (batchYear !== 0 && (batchYear < 1900 || batchYear > 2200)) throw badRequest('batch_year is not a year this school could have run')
  const country = req.country || 'India'
  const contactable = req.contactable === undefined || req.contactable === null ? 1 : req.contactable ? 1 : 0
  const vals = [nullStr(str(req.occupation)), nullStr(str(req.employer)), nullStr(str(req.higher_study)), nullStr(str(req.city)), country, nullStr(str(req.email)), nullStr(str(req.phone)), contactable, nullStr(str(req.notes))]
  const existing = await c.db.prepare(`SELECT id FROM alumni_profiles WHERE student_id = ?`).bind(req.student_id).first<{ id: string }>()
  try {
    if (existing) {
      await c.db.prepare(`UPDATE alumni_profiles SET batch_year = COALESCE(?, batch_year), occupation = ?, employer = ?, higher_study = ?, city = ?, country = ?, email = ?, phone = ?, contactable = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .bind(batchYear === 0 ? null : batchYear, ...vals, now(), existing.id).run()
      return ok({ id: existing.id })
    }
    const id = uuid()
    const today = indiaToday()
    await c.db.prepare(`INSERT INTO alumni_profiles (id, institution_id, student_id, batch_year, occupation, employer, higher_study, city, country, email, phone, contactable, notes, created_at, updated_at)
      SELECT ?, ?, ?, COALESCE(?, ${BATCH_YEAR_SQL('exit_date')}), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM students WHERE id = ?`)
      .bind(id, inst(c), req.student_id, batchYear === 0 ? null : batchYear, today, today, today, ...vals, now(), now(), req.student_id).run()
    return ok({ id })
  } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
}

async function saveAlumniEvent(c: Ctx) {
  const req = await readJSON<{ id?: string; academic_year_id?: string; title?: string; on_date?: string; venue?: string; description?: string; expected?: number | null; status?: string }>(c.req)
  const title = str(req.title).trim()
  if (title === '' || str(req.on_date).trim() === '') throw badRequest('title and on_date are both required')
  const status = req.status || 'planned'
  if (!['planned', 'open', 'held', 'cancelled'].includes(status)) throw badRequest('status must be planned, open, held or cancelled')
  const expected = req.expected ?? null
  if (req.id) {
    const res = await c.db.prepare(`UPDATE alumni_events SET title = ?, on_date = ?, venue = ?, description = ?, expected = ?, status = ? WHERE id = ?`)
      .bind(title, req.on_date, nullStr(str(req.venue)), nullStr(str(req.description)), expected, status, req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  const existing = await c.db.prepare(`SELECT id FROM alumni_events WHERE institution_id = ? AND on_date = ? AND lower(title) = lower(?)`).bind(inst(c), req.on_date, title).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE alumni_events SET venue = ?, description = ?, expected = ?, status = ? WHERE id = ?`).bind(nullStr(str(req.venue)), nullStr(str(req.description)), expected, status, existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO alumni_events (id, institution_id, academic_year_id, title, on_date, venue, description, expected, status, created_by, created_at)
    VALUES (?, ?, COALESCE(?, (SELECT id FROM academic_years WHERE is_current = 1 ORDER BY starts_on DESC LIMIT 1)), ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), nullStr(str(req.academic_year_id)), title, req.on_date, nullStr(str(req.venue)), nullStr(str(req.description)), expected, status, c.id.userId, now()).run()
  return ok({ id })
}

async function recordAlumniAttendance(c: Ctx) {
  const event = c.params.id
  if (!isUUID(event)) throw badRequest('invalid event id')
  const req = await readJSON<{ entries?: { alumni_profile_id?: string; rsvp?: string; attended?: boolean | null; guests?: number | null }[] }>(c.req)
  const entries = req.entries ?? []
  if (entries.length === 0) throw badRequest('send at least one entry')
  const stmts: D1PreparedStatement[] = []
  for (const e of entries) {
    if (!isUUID(e.alumni_profile_id)) throw badRequest('alumni_profile_id must be a uuid')
    const rsvp = e.rsvp || 'invited'
    if (!['invited', 'yes', 'no', 'maybe'].includes(rsvp)) throw badRequest('rsvp must be invited, yes, no or maybe')
    const attended = e.attended ? 1 : 0
    const guests = e.guests && e.guests > 0 ? e.guests : 0
    stmts.push(c.db.prepare(`INSERT INTO alumni_event_rsvps (id, institution_id, event_id, alumni_profile_id, rsvp, attended, guests, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (event_id, alumni_profile_id) DO UPDATE SET rsvp = excluded.rsvp, attended = excluded.attended, guests = excluded.guests`)
      .bind(uuid(), inst(c), event, e.alumni_profile_id, rsvp, attended, guests, now()))
  }
  try { await batch(c, stmts) } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
  return ok({ recorded: stmts.length })
}

async function recordAlumniContribution(c: Ctx) {
  const req = await readJSON<{ alumni_profile_id?: string; event_id?: string; received_on?: string; amount_paise?: number; kind?: string; purpose?: string; receipt_no?: string; acknowledged?: boolean }>(c.req)
  if (!isUUID(req.alumni_profile_id)) throw badRequest('alumni_profile_id must be a uuid')
  const amount = Number(req.amount_paise ?? 0)
  if (!(amount > 0)) throw badRequest('amount_paise must be more than zero')
  const kind = req.kind || 'cash'
  if (!['cash', 'kind', 'scholarship', 'infrastructure'].includes(kind)) throw badRequest('kind must be cash, kind, scholarship or infrastructure')
  const receipt = nullStr(str(req.receipt_no))
  if (receipt !== null) {
    // alumni_contributions_receipt was a unique index in Postgres; refused here in the same words.
    const dup = await c.db.prepare(`SELECT 1 AS ok FROM alumni_contributions WHERE institution_id = ? AND receipt_no = ?`).bind(inst(c), receipt).first()
    if (dup) throw coded(409, 'duplicate_receipt', 'that receipt number is already against another gift, check the counterfoil')
  }
  const id = uuid()
  try {
    await c.db.prepare(`INSERT INTO alumni_contributions (id, institution_id, alumni_profile_id, event_id, received_on, amount_paise, kind, purpose, receipt_no, acknowledged, recorded_by, created_at)
      VALUES (?, ?, ?, ?, COALESCE(?, ?), ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), req.alumni_profile_id, nullStr(str(req.event_id)), nullStr(str(req.received_on)), indiaToday(), amount, kind, nullStr(str(req.purpose)), receipt, req.acknowledged ? 1 : 0, c.id.userId, now()).run()
  } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)) }
  return created({ id })
}

// --- certificate and document templates ---------------------------------------------------------------------------------------

const certificatePlaceholders = [
  { token: '{{student_name}}', means: "the child's full name" }, { token: '{{admission_no}}', means: 'admission number' },
  { token: '{{class}}', means: 'current class' }, { token: '{{section}}', means: 'current section' },
  { token: '{{date_of_birth}}', means: 'date of birth' }, { token: '{{guardian_name}}', means: 'the guardian on record' },
  { token: '{{admission_date}}', means: 'date of admission' }, { token: '{{exit_date}}', means: 'date of leaving, where recorded' },
  { token: '{{school_name}}', means: "the institution's name" }, { token: '{{serial_no}}', means: 'the certificate serial' },
  { token: '{{issued_on}}', means: "today's date" }, { token: '{{signatory}}', means: 'the name configured on the template' },
  { token: '{{signatory_role}}', means: 'the designation configured on the template' },
]

async function listCertificateTemplates(c: Ctx) {
  const kind = nullStr(q(c, 'subject_kind')), activeOnly = q(c, 'active') === '1' ? 1 : 0
  const rows = await c.db.prepare(`
    SELECT ct.id, ct.code, ct.name, ct.subject_kind, ct.is_active, ct.requires_approval, ct.description, ct.template_html, ct.page_size, ct.orientation, ct.serial_prefix, ct.signatory, ct.signatory_role,
           (SELECT count(*) FROM issued_certificates ic WHERE ic.certificate_type_id = ct.id AND ic.status = 'issued') AS issued,
           (SELECT count(*) FROM issued_certificates ic WHERE ic.certificate_type_id = ct.id AND ic.status IN ('requested','approved')) AS pending,
           (SELECT max(ic.issued_on) FROM issued_certificates ic WHERE ic.certificate_type_id = ct.id) AS last_issued_on
      FROM certificate_types ct WHERE (? IS NULL OR ct.subject_kind = ?) AND (NOT ? OR ct.is_active = 1) ORDER BY ct.subject_kind, ct.name`)
    .bind(kind, kind, activeOnly).all<Record<string, unknown>>()
  let unconfigured = 0
  const items = rows.results.map((v) => {
    const needsBody = v.template_html === null || str(v.template_html).trim() === ''
    if (needsBody && bool(v.is_active)) unconfigured++
    return omitNull({ ...v, is_active: bool(v.is_active), requires_approval: bool(v.requires_approval), needs_body: needsBody },
      ['description', 'template_html', 'serial_prefix', 'signatory', 'signatory_role', 'last_issued_on'])
  })
  return ok({ items, placeholders: certificatePlaceholders, summary: { templates: items.length, unconfigured } })
}

async function saveCertificateTemplate(c: Ctx) {
  const req = await readJSON<{ id?: string; code?: string; name?: string; subject_kind?: string; is_active?: boolean | null; requires_approval?: boolean | null; description?: string
    template_html?: string; page_size?: string; orientation?: string; serial_prefix?: string; signatory?: string; signatory_role?: string }>(c.req)
  const code = str(req.code).trim().toUpperCase(), name = str(req.name).trim()
  if (!req.id && code === '') throw badRequest('code is required for a new template')
  if (name === '') throw badRequest('name is required')
  const subjectKind = req.subject_kind || 'student'
  if (subjectKind !== 'student' && subjectKind !== 'staff') throw badRequest('subject_kind must be student or staff')
  const pageSize = req.page_size || 'A4'
  if (!['A4', 'A5', 'Letter', 'Legal'].includes(pageSize)) throw badRequest('page_size must be A4, A5, Letter or Legal')
  const orientation = req.orientation || 'portrait'
  if (orientation !== 'portrait' && orientation !== 'landscape') throw badRequest('orientation must be portrait or landscape')
  const active = req.is_active === undefined || req.is_active === null ? 1 : req.is_active ? 1 : 0
  const approval = req.requires_approval === undefined || req.requires_approval === null ? 1 : req.requires_approval ? 1 : 0
  const vals = [name, subjectKind, active, approval, nullStr(str(req.description)), nullStr(str(req.template_html)), pageSize, orientation,
    nullStr(str(req.serial_prefix)), nullStr(str(req.signatory)), nullStr(str(req.signatory_role))]
  const update = (id: string) => c.db.prepare(`UPDATE certificate_types SET name = ?, subject_kind = ?, is_active = ?, requires_approval = ?, description = ?, template_html = ?, page_size = ?, orientation = ?,
      serial_prefix = ?, signatory = ?, signatory_role = ?, updated_at = ? WHERE id = ?`).bind(...vals, now(), id)
  if (req.id) {
    const res = await update(req.id).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: req.id })
  }
  const existing = await c.db.prepare(`SELECT id FROM certificate_types WHERE institution_id = ? AND code = ?`).bind(inst(c), code).first<{ id: string }>()
  if (existing) { await update(existing.id).run(); return ok({ id: existing.id }) }
  const id = uuid()
  await c.db.prepare(`INSERT INTO certificate_types (id, institution_id, code, name, subject_kind, is_active, requires_approval, description, template_html, page_size, orientation, serial_prefix, signatory, signatory_role, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, inst(c), code, ...vals, now()).run()
  return ok({ id })
}

const ddmmyyyy = (d: unknown) => (typeof d === 'string' && d.length >= 10 ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '')

async function previewCertificateTemplate(c: Ctx) {
  const tmplId = c.params.id
  if (!isUUID(tmplId)) throw badRequest('invalid template id')
  const raw = q(c, 'student_id')
  if (raw !== '' && !isUUID(raw)) throw badRequest('student_id must be a uuid')
  const student = raw === '' ? null : raw
  const t = await c.db.prepare(`SELECT COALESCE(template_html,'') AS body, name, COALESCE(serial_prefix,'') AS prefix, COALESCE(signatory,'') AS signatory, COALESCE(signatory_role,'') AS role FROM certificate_types WHERE id = ?`)
    .bind(tmplId).first<{ body: string; name: string; prefix: string; signatory: string; role: string }>()
  if (!t) throw notFoundGo()
  const st = await c.db.prepare(`
    SELECT ${fullName('st')} AS student_name, COALESCE(st.admission_no,'') AS admission_no, COALESCE(c.name,'') AS class, COALESCE(sec.name,'') AS section, st.date_of_birth,
           COALESCE((SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1), '') AS guardian,
           st.admission_date, st.exit_date
      FROM students st ${CUR_ENROLMENT}
     WHERE (? IS NULL OR st.id = ?) ORDER BY (st.id = ?) DESC, st.admission_no LIMIT 1`).bind(student, student, student).first<Record<string, unknown>>()
  const fields: Record<string, string> = {
    '{{student_name}}': str(st?.student_name), '{{admission_no}}': str(st?.admission_no), '{{class}}': str(st?.class), '{{section}}': str(st?.section),
    '{{date_of_birth}}': ddmmyyyy(st?.date_of_birth), '{{guardian_name}}': str(st?.guardian), '{{admission_date}}': ddmmyyyy(st?.admission_date),
    '{{exit_date}}': ddmmyyyy(st?.exit_date), '{{school_name}}': c.id.institution?.name ?? '',
    '{{serial_no}}': t.prefix + 'PREVIEW', '{{issued_on}}': ddmmyyyy(indiaToday()), '{{signatory}}': t.signatory, '{{signatory_role}}': t.role,
  }
  let rendered = t.body
  const unfilled: string[] = []
  for (const [token, value] of Object.entries(fields)) {
    if (value === '' && rendered.includes(token)) unfilled.push(token)
    rendered = rendered.split(token).join(value)
  }
  unfilled.sort()
  return ok({ template: t.name, rendered, empty: t.body.trim() === '', unfilled, issued_on: fields['{{issued_on}}'] })
}
