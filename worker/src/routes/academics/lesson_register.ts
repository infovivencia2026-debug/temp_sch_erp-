import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, isUUID, ok, readJSON, uuid, now } from '../../http'
import { addDays, can, forbiddenMsg, indiaToday, inst, isDate, isodow, workingYear } from '../students/common'
import { school } from '../school'
import { buildXLSX, XLSX_CONTENT_TYPE } from '../../services/xlsx'

/* THE LESSON PLAN REGISTER (owner, 2026-10-30): one row per timetabled period
   of a class's subject on a school date, with the topic and how far it got.

   The rows are worked out, not typed: every date in the year whose weekday
   carries that period in the timetable is a row, marked Working, Holiday or
   Exam from the school calendar. Only a period somebody has written to is
   stored (lesson_register). The principal reads everything, by teacher or by
   class; a teacher reads and writes only the periods the timetable gives
   them. Status moves forward only. */

export const STATUSES = ['not_completed', 'ongoing', 'completed'] as const
export type Status = typeof STATUSES[number]
export type DayType = 'working' | 'holiday' | 'exam'
/** The school's day codes, as on its own sheet: teaching, holiday, non-teaching, teaching + event, non-teaching event. */
export const DAY_CODES = ['TD', 'HD', 'ND', 'TED', 'NED'] as const
export type DayCode = typeof DAY_CODES[number]
const CODE_OF: Record<DayType, DayCode> = { working: 'TD', holiday: 'HD', exam: 'ND' }

export function registerLessonRegister(r: Router) {
  r.get('/academics/lesson-register/options', 'auth', getOptions)
  r.get('/academics/lesson-register', 'auth', getRegister)
  r.put('/academics/lesson-register', 'auth', saveEntry)
}

/** Reads every class's register: the principal and anyone who runs academics. */
const seesAll = (c: Ctx) => can(c, 'academics.write') || can(c, 'hr.leave.approve')

interface Slot {
  section_id: string; class_subject_id: string; period_id: string; weekday: number; sequence: number; period: string
  class_name: string; section: string; subject: string; teacher_user_id: string | null; teacher: string | null
}

async function yearRange(c: Ctx): Promise<{ id: string; from: string; to: string }> {
  const id = await workingYear(c)
  const y = await c.db.prepare(`SELECT starts_on, ends_on FROM academic_years WHERE id = ?`).bind(id).first<{ starts_on: string; ends_on: string }>()
  if (!y) throw new HttpError(404, 'no academic year is set up')
  return { id, from: y.starts_on.slice(0, 10), to: y.ends_on.slice(0, 10) }
}

async function getOptions(c: Ctx) {
  const year = await yearRange(c)
  const all = seesAll(c)
  const rows = await c.db.prepare(`
    SELECT DISTINCT te.section_id, cl.name AS class_name, sec.name AS section, te.class_subject_id, sub.name AS subject, te.teacher_user_id, u.full_name AS teacher
      FROM timetable_entries te JOIN sections sec ON sec.id = te.section_id JOIN classes cl ON cl.id = sec.class_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = te.teacher_user_id
     WHERE te.academic_year_id = ? AND (? = 1 OR te.teacher_user_id = ?)`)
    .bind(year.id, all ? 1 : 0, c.id.userId)
    .all<{ section_id: string; class_name: string; section: string; class_subject_id: string; subject: string; teacher_user_id: string | null; teacher: string | null }>()
  const sections = new Map<string, { id: string; class_name: string; section: string }>()
  const subjects = new Map<string, { section_id: string; class_subject_id: string; subject: string }>()
  const teachers = new Map<string, { id: string; name: string }>()
  for (const v of rows.results) {
    sections.set(v.section_id, { id: v.section_id, class_name: v.class_name, section: v.section })
    subjects.set(`${v.section_id}|${v.class_subject_id}`, { section_id: v.section_id, class_subject_id: v.class_subject_id, subject: v.subject })
    if (all && v.teacher_user_id && v.teacher) teachers.set(v.teacher_user_id, { id: v.teacher_user_id, name: v.teacher })
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
  return ok({
    sees_all: all,
    year: { from: year.from, to: year.to },
    teachers: [...teachers.values()].sort((a, b) => byName(a.name, b.name)),
    sections: [...sections.values()].sort((a, b) => byName(a.class_name, b.class_name) || byName(a.section, b.section)),
    subjects: [...subjects.values()].sort((a, b) => byName(a.subject, b.subject)),
  })
}

/** Working, Holiday or Exam for each date in [from, to]; Sundays are holidays unless the calendar makes them working days. */
async function dayTypes(c: Ctx, from: string, to: string): Promise<Map<string, DayType>> {
  return new Map([...(await dayInfo(c, from, to))].map(([d, v]) => [d, v.type]))
}

/** Each date's type and, for a holiday, its name ("Sunday" for a plain Sunday). */
async function dayInfo(c: Ctx, from: string, to: string): Promise<Map<string, { type: DayType; name: string }>> {
  const [hol, exams] = await c.db.batch([
    c.db.prepare(`SELECT on_date, COALESCE(to_date, on_date) AS to_date, kind, applies_to, name FROM holidays WHERE on_date <= ? AND COALESCE(to_date, on_date) >= ?`).bind(to, from),
    c.db.prepare(`SELECT starts_on, COALESCE(ends_on, starts_on) AS ends_on FROM exams WHERE starts_on IS NOT NULL AND starts_on <= ? AND COALESCE(ends_on, starts_on) >= ?`).bind(to, from),
  ])
  const hs = hol.results as { on_date: string; to_date: string; kind: string; applies_to: string; name: string }[]
  const es = exams.results as { starts_on: string; ends_on: string }[]
  const out = new Map<string, { type: DayType; name: string }>()
  for (let d = from; d <= to; d = addDays(d, 1)) {
    let shut = isodow(d) === 7, working = false, exam = false
    let name = shut ? 'Sunday' : ''
    for (const h of hs) {
      if (d < h.on_date.slice(0, 10) || d > h.to_date.slice(0, 10)) continue
      if ((h.kind === 'holiday' || h.kind === 'vacation') && (h.applies_to === 'all' || h.applies_to === 'students')) { shut = true; name = h.name }
      if (h.kind === 'working_day') working = true
      if (h.kind === 'exam') exam = true
    }
    for (const e of es) if (d >= e.starts_on.slice(0, 10) && d <= e.ends_on.slice(0, 10)) exam = true
    const type: DayType = working ? (exam ? 'exam' : 'working') : shut ? 'holiday' : exam ? 'exam' : 'working'
    out.set(d, { type, name: type === 'holiday' ? name : '' })
  }
  return out
}

async function getRegister(c: Ctx) {
  const p = c.url.searchParams
  const year = await yearRange(c)
  const all = seesAll(c)
  const section = p.get('section_id') ?? '', subject = p.get('class_subject_id') ?? ''
  let teacher = p.get('teacher_user_id') ?? ''
  for (const v of [section, subject, teacher]) if (v && !isUUID(v)) throw badRequest('ids must be uuids')
  if (!all) teacher = c.id.userId
  if (!section && !teacher) throw badRequest('choose a teacher or a class')

  const slots = (await c.db.prepare(`
    SELECT te.section_id, te.class_subject_id, te.period_id, te.weekday, p.sequence, p.name AS period,
           cl.name AS class_name, sec.name AS section, sub.name AS subject, te.teacher_user_id, u.full_name AS teacher
      FROM timetable_entries te JOIN periods p ON p.id = te.period_id
      JOIN sections sec ON sec.id = te.section_id JOIN classes cl ON cl.id = sec.class_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = te.teacher_user_id
     WHERE te.academic_year_id = ? AND (? = '' OR te.section_id = ?) AND (? = '' OR te.class_subject_id = ?) AND (? = '' OR te.teacher_user_id = ?)`)
    .bind(year.id, section, section, subject, subject, teacher, teacher).all<Slot>()).results
  if (!slots.length) return ok({ items: [] })

  const sectionIds = [...new Set(slots.map((s) => s.section_id))]
  /* THE SCHOOL'S OWN START AND END (owner, 2026-10-30: the micro schedule
     runs 16 March to 15 March, not the ERP's April-to-March year). Where the
     school's schedule is loaded its first and last dates are the range;
     otherwise the academic year. */
  const span = await c.db.prepare(`SELECT min(on_date) AS a, max(on_date) AS b FROM lesson_register_days
     WHERE section_id IN (SELECT value FROM json_each(?)) AND (? = '' OR class_subject_id = ?)`)
    .bind(JSON.stringify(sectionIds), subject, subject).first<{ a: string | null; b: string | null }>()
  const from = isDate(p.get('from') ?? '') ? p.get('from')! : span?.a ?? year.from
  const to = isDate(p.get('to') ?? '') ? p.get('to')! : span?.b ?? year.to
  if (from > to) throw badRequest('from must be on or before to')
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw badRequest('choose a range of a year or less')
  const [saved, dayRows] = await c.db.batch([
    c.db.prepare(`SELECT section_id, class_subject_id, on_date, period_id, topic, status FROM lesson_register
       WHERE on_date BETWEEN ? AND ? AND section_id IN (SELECT value FROM json_each(?))`).bind(from, to, JSON.stringify(sectionIds)),
    c.db.prepare(`SELECT section_id, class_subject_id, on_date, day_type, topic, status FROM lesson_register_days
       WHERE on_date BETWEEN ? AND ? AND section_id IN (SELECT value FROM json_each(?))`).bind(from, to, JSON.stringify(sectionIds)),
  ])
  const kept = new Map((saved.results as { section_id: string; class_subject_id: string; on_date: string; period_id: string; topic: string | null; status: Status }[])
    .map((v) => [`${v.section_id}|${v.class_subject_id}|${v.on_date}|${v.period_id}`, v]))
  /* The school's own word for a day (its code and, on a day nothing is
     taught, what the day was). Read for one class's subject; a teacher's
     view across classes uses the calendar alone. */
  const one = section && subject ? `${section}|${subject}` : ''
  type DayRow = { section_id: string; class_subject_id: string; on_date: string; day_type: DayCode; topic: string | null; status: Status | null }
  const dayAll = new Map((dayRows.results as DayRow[]).map((v) => [`${v.section_id}|${v.class_subject_id}|${v.on_date}`, v]))
  const dayOf = new Map((dayRows.results as DayRow[]).filter((v) => `${v.section_id}|${v.class_subject_id}` === one).map((v) => [v.on_date, v]))

  const days = await dayInfo(c, from, to)
  const byWeekday = new Map<number, Slot[]>()
  for (const s of slots) byWeekday.set(s.weekday, [...(byWeekday.get(s.weekday) ?? []), s])
  for (const list of byWeekday.values()) list.sort((a, b) => a.sequence - b.sequence || a.class_name.localeCompare(b.class_name, undefined, { numeric: true }))
  const head = slots[0]
  // The subject's teacher writes even on a date it has no period (a Saturday on the sheet).
  const teachesIt = one !== '' && slots.some((s) => s.teacher_user_id === c.id.userId)

  /* EVERY DATE, LIKE THE SCHOOL'S SHEET: a date with periods of this subject
     is one row per period; a date without (a Sunday, a holiday, a day the
     subject is not on the timetable) is one row naming the day. */
  const items: Record<string, unknown>[] = []
  for (const [d, info] of days) {
    const own = dayOf.get(d)
    const code: DayCode = own?.day_type ?? CODE_OF[info.type]
    /* One row per date for one class's subject, like the school's sheet: a
       subject taught twice that day is planned on its first period. */
    const all = code === 'HD' ? [] : byWeekday.get(isodow(d)) ?? []
    const periods = one ? all.slice(0, 1) : all
    if (!periods.length) {
      items.push({
        sno: items.length + 1, date: d, day_type: code, period_id: '', period: '',
        section_id: one ? head.section_id : '', class_subject_id: one ? head.class_subject_id : '',
        class_name: one ? head.class_name : '', section: one ? head.section : '', subject: one ? head.subject : '', teacher: '',
        topic: own?.topic ?? info.name,
        status: one && code !== 'HD' && (own || teachesIt) ? own?.status ?? (own?.topic || teachesIt ? 'not_completed' : null) : null,
        mine: teachesIt && code !== 'HD',
      })
      continue
    }
    for (const s of periods) {
      const k = kept.get(`${s.section_id}|${s.class_subject_id}|${d}|${s.period_id}`)
      const sched = dayAll.get(`${s.section_id}|${s.class_subject_id}|${d}`)
      // A class's own schedule says a holiday that the calendar does not: no period that day.
      if (!one && sched?.day_type === 'HD') continue
      items.push({
        sno: items.length + 1, date: d, day_type: code,
        section_id: s.section_id, class_subject_id: s.class_subject_id, period_id: s.period_id, period: s.period,
        class_name: s.class_name, section: s.section, subject: s.subject, teacher: s.teacher ?? '',
        topic: k?.topic ?? sched?.topic ?? '', status: k?.status ?? sched?.status ?? 'not_completed',
        mine: s.teacher_user_id === c.id.userId,
      })
    }
  }
  /* A RUN OF HOLIDAYS IS ONE ROW (owner, 2026-10-30: "mark holiday for all
     at once like summer"): two or more holidays in a row, Sundays included,
     read as one line from the first date to the last. */
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.day_type !== 'HD' || it.period_id !== '') { rows.push({ ...it, sno: rows.length + 1 }); continue }
    let j = i
    while (j + 1 < items.length && items[j + 1].day_type === 'HD' && items[j + 1].period_id === '') j++
    if (j === i) { rows.push({ ...it, sno: rows.length + 1 }); continue }
    const names = items.slice(i, j + 1).map((x) => String(x.topic ?? '')).filter((t) => t && t !== 'Sunday')
    rows.push({ ...it, sno: rows.length + 1, date_to: items[j].date, topic: [...new Set(names)].join(' / ') || 'Holiday' })
    i = j
  }
  if (p.get('format') === 'xlsx') return registerSheet(c, rows, !one)
  return ok({ items: rows, today: indiaToday() })
}

async function saveEntry(c: Ctx) {
  const req = await readJSON<{ section_id?: string; class_subject_id?: string; period_id?: string; on_date?: string; topic?: string; status?: string }>(c.req)
  if (!isUUID(req.section_id) || !isUUID(req.class_subject_id)) throw badRequest('section_id and class_subject_id must be uuids')
  if (req.period_id && !isUUID(req.period_id)) throw badRequest('period_id must be a uuid')
  const day = req.on_date ?? ''
  if (!isDate(day)) throw badRequest('on_date must be YYYY-MM-DD')
  if (req.status !== undefined && !STATUSES.includes(req.status as Status)) throw badRequest('status must be not_completed, ongoing or completed')
  if (req.topic !== undefined && typeof req.topic !== 'string') throw badRequest('topic must be text')
  const topic = req.topic === undefined ? undefined : req.topic.trim().slice(0, 500)

  const year = await yearRange(c)
  const inSchedule = await c.db.prepare(`SELECT 1 FROM lesson_register_days WHERE section_id = ? AND class_subject_id = ? AND on_date = ?`)
    .bind(req.section_id, req.class_subject_id, day).first()
  if (!inSchedule && (day < year.from || day > year.to)) throw badRequest('that date is outside the academic year')
  if (!req.period_id) return saveDay(c, year.id, req.section_id!, req.class_subject_id!, day, topic, req.status as Status | undefined)
  const slot = await c.db.prepare(`SELECT teacher_user_id FROM timetable_entries WHERE academic_year_id = ? AND section_id = ? AND class_subject_id = ? AND period_id = ? AND weekday = ?`)
    .bind(year.id, req.section_id, req.class_subject_id, req.period_id, isodow(day)).first<{ teacher_user_id: string | null }>()
  if (!slot) throw new HttpError(404, 'that class has no such period on that day in the timetable')
  if (slot.teacher_user_id !== c.id.userId) throw forbiddenMsg('only the teacher of this period can change its lesson plan')
  if ((await dayTypes(c, day, day)).get(day) === 'holiday') throw badRequest('that day is a holiday')

  const prev = await c.db.prepare(`SELECT id, topic, status FROM lesson_register WHERE section_id = ? AND class_subject_id = ? AND on_date = ? AND period_id = ?`)
    .bind(req.section_id, req.class_subject_id, day, req.period_id).first<{ id: string; topic: string | null; status: Status }>()
  // A period nobody wrote to yet starts from the class's schedule for that date.
  const sched = prev ? null : await c.db.prepare(`SELECT topic, status FROM lesson_register_days WHERE section_id = ? AND class_subject_id = ? AND on_date = ?`)
    .bind(req.section_id, req.class_subject_id, day).first<{ topic: string | null; status: Status | null }>()
  const before = prev?.status ?? sched?.status ?? 'not_completed'
  const after = (req.status as Status | undefined) ?? before
  if (STATUSES.indexOf(after) < STATUSES.indexOf(before)) {
    throw new HttpError(409, 'a status only moves forward: not completed, then ongoing, then completed', { code: 'status_backwards' })
  }
  const nextTopic = topic === undefined ? prev?.topic ?? sched?.topic ?? null : topic || null
  if (prev) {
    await c.db.prepare(`UPDATE lesson_register SET topic = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(nextTopic, after, c.id.userId, now(), prev.id).run()
  } else {
    await c.db.prepare(`INSERT INTO lesson_register (id, institution_id, section_id, class_subject_id, on_date, period_id, topic, status, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst(c), req.section_id, req.class_subject_id, day, req.period_id, nextTopic, after, c.id.userId, now()).run()
  }
  return ok({ topic: nextTopic ?? '', status: after })
}

/* A date the subject has no period on (a Saturday on the school's sheet):
   the topic and status live on the day itself. Only a teacher of the
   subject in that class writes it, and only on a date the schedule holds. */
async function saveDay(c: Ctx, yearId: string, section: string, subject: string, day: string, topic: string | undefined, status: Status | undefined) {
  const teaches = await c.db.prepare(`SELECT 1 FROM timetable_entries WHERE academic_year_id = ? AND section_id = ? AND class_subject_id = ? AND teacher_user_id = ?`)
    .bind(yearId, section, subject, c.id.userId).first()
  if (!teaches) throw forbiddenMsg('only the teacher of this subject can change its lesson plan')
  const prev = await c.db.prepare(`SELECT day_type, topic, status FROM lesson_register_days WHERE section_id = ? AND class_subject_id = ? AND on_date = ?`)
    .bind(section, subject, day).first<{ day_type: DayCode; topic: string | null; status: Status | null }>()
  // A date no schedule was loaded for takes its type from the calendar.
  const code: DayCode = prev?.day_type ?? CODE_OF[(await dayTypes(c, day, day)).get(day) ?? 'working']
  if (code === 'HD') throw badRequest('that day is a holiday')
  const before = prev?.status ?? 'not_completed'
  const after = status ?? before
  if (STATUSES.indexOf(after) < STATUSES.indexOf(before)) {
    throw new HttpError(409, 'a status only moves forward: not completed, then ongoing, then completed', { code: 'status_backwards' })
  }
  const nextTopic = topic === undefined ? prev?.topic ?? null : topic || null
  await c.db.prepare(`INSERT INTO lesson_register_days (institution_id, section_id, class_subject_id, on_date, day_type, topic, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (section_id, class_subject_id, on_date) DO UPDATE SET topic = excluded.topic, status = excluded.status, updated_at = excluded.updated_at`)
    .bind(inst(c), section, subject, day, code, nextTopic, after, now()).run()
  return ok({ topic: nextTopic ?? '', status: after })
}

const STATUS_WORD: Record<Status, string> = { not_completed: 'Not completed', ongoing: 'Ongoing', completed: 'Completed' }
const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const wd = (d: string) => WEEKDAY[new Date(d + 'T00:00:00Z').getUTCDay()]

/* THE REGISTER AS A SHEET (owner, 2026-10-30: "add sheet export"), laid out
   like the school's own micro schedule: the school, the class and subject,
   then S.No, Date, Day, Day type, Period, Topic, Status. */
function registerSheet(c: Ctx, rows: Record<string, unknown>[], withClass: boolean): Response {
  const first = rows[0] ?? {}
  const title = withClass ? `Teacher: ${String(first.teacher ?? '')}` : `Class: ${first.class_name ?? ''} - ${first.section ?? ''}    Subject: ${first.subject ?? ''}`
  const head = ['S.No', 'Date', 'Day', 'Day type', ...(withClass ? ['Class', 'Subject'] : []), 'Period', 'Topic', 'Status']
  const last = String.fromCharCode(64 + head.length)
  const out: (string | null)[][] = [[school(c).name], ['Lesson plan'], [title], head]
  for (const r of rows) {
    const d = String(r.date), to = r.date_to ? String(r.date_to) : ''
    out.push([
      String(r.sno), to ? `${dmy(d)} to ${dmy(to)}` : dmy(d), to ? `${wd(d)} to ${wd(to)}` : wd(d), String(r.day_type),
      ...(withClass ? [`${r.class_name} - ${r.section}`, String(r.subject)] : []),
      String(r.period ?? ''), String(r.topic ?? ''), r.status ? STATUS_WORD[r.status as Status] : '',
    ])
  }
  const bytes = buildXLSX([{
    name: 'Lesson plan', rows: out, boldRows: [0, 1, 3], merges: [`A1:${last}1`, `A2:${last}2`, `A3:${last}3`],
    colWidths: [6, 24, 12, 9, ...(withClass ? [16, 16] : []), 10, 60, 14],
  }])
  const name = withClass ? 'lesson-plan' : `lesson-plan-${first.class_name ?? ''}-${first.section ?? ''}-${first.subject ?? ''}`.replace(/[^A-Za-z0-9-]+/g, '-')
  return new Response(bytes, { headers: { 'content-type': XLSX_CONTENT_TYPE, 'content-disposition': `attachment; filename="${name}.xlsx"` } })
}
