import type { Ctx } from '../../../router'
import { can } from '../../../identity'
import { indiaToday } from '../../students/common'
import { findSection, isDate, isFamily, num, readAs, refusal, rowsOf, screenLink, str, studentLink } from './read'
import { fail, table, type ToolSpec } from './tools'

/* Read tools for the questions a school office asks most: its classes and
   class teachers, how many students, birthdays, and who has been away for
   days in a row. Like tools.ts, each reads through a Worker route as the
   caller, so a teacher gets their own sections and nothing else. */

type Row = Record<string, unknown>
const bare = (s: string) => s.trim().toLowerCase().replace(/^(class|grade|std\.?|standard)\s*/, '')
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

const classSections: ToolSpec = {
  name: 'class_sections', label: 'Reading classes and sections',
  description: 'The sections of each class this year, with the class teacher and how many students are enrolled in each. Use it for "who is the class teacher of ...", "what sections does Grade 3 have", "how many students in Grade 5", and to find a section\'s real name (sections may be words such as BODHA, not letters).',
  params: { class: { type: 'STRING', description: 'Class, e.g. "4" or "Grade 4" (optional: all classes)' }, section: { type: 'STRING', description: 'Section (optional)' } },
  offer: (c) => can(c.id, 'academics.read'),
  run: async (c, a) => {
    const year = await c.db.prepare('SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1').first<{ id: string }>()
    const g = await readAs(c, '/academics/sections', { academic_year_id: year?.id })
    if (g.status !== 200) return fail(refusal(g))
    const cls = bare(str(a, 'class')), sec = str(a, 'section').toLowerCase()
    let rows = rowsOf(g.data)
    if (cls) rows = rows.filter((r) => bare(String(r.class_name ?? '')) === cls)
    if (sec) {
      const exact = rows.filter((r) => String(r.name ?? '').toLowerCase() === sec)
      rows = exact.length ? exact : rows.filter((r) => String(r.name ?? '').toLowerCase().startsWith(sec))
    }
    if (rows.length === 0) return fail(cls ? `no class "${str(a, 'class')}"${sec ? ` section "${str(a, 'section')}"` : ''} this year` : 'no sections set up this year')
    const shaped = rows.map((r) => ({ class: r.class_name, section: r.name, class_teacher: r.class_teacher ?? 'not set', students: Number(r.enrolled ?? 0) }))
    const total = shaped.reduce((s, r) => s + r.students, 0)
    return { ...table('Classes and sections', shaped, [['class', 'Class'], ['section', 'Section'], ['class_teacher', 'Class teacher'], ['students', 'Students']], undefined,
      { stats: [{ label: 'Sections', value: shaped.length }, { label: 'Students', value: total }] }), links: [screenLink('class_setup', 'Class setup')] }
  },
}

const studentCount: ToolSpec = {
  name: 'student_count', label: 'Counting students',
  description: 'How many students the person can see: active, left, suspended and new this year for the whole school, or the active count of one class or section.',
  params: { class: { type: 'STRING', description: 'Class (optional)' }, section: { type: 'STRING', description: 'Section (optional)' } },
  offer: (c) => can(c.id, 'students.read'),
  run: async (c, a) => {
    if (!str(a, 'class')) {
      const g = await readAs(c, '/students/counts')
      if (g.status !== 200) return fail(refusal(g))
      const d = g.data as Record<string, number>
      const stats = [{ label: 'Active', value: d.active ?? 0 }, { label: 'New this year', value: d.new_this_year ?? 0 }, { label: 'Left', value: d.left ?? 0 }, { label: 'Suspended', value: d.suspended ?? 0 }]
      return { data: d, view: { title: 'Students', columns: [], rows: [], stats }, links: [screenLink('students', 'Students')] }
    }
    const s = await findSection(c, str(a, 'class'), str(a, 'section'))
    const q: Record<string, string | number> = { limit: 1, with_total: 1 }
    if (s.one) q.section_id = s.one.id
    else if (s.classOnly) q.class_id = s.classOnly.id
    else return fail(s.error!)
    const g = await readAs(c, '/students', q)
    if (g.status !== 200) return fail(refusal(g))
    const n = Number((g.data as Row).total ?? 0), label = s.one?.label ?? s.classOnly!.name
    return { data: { class: label, active_students: n }, view: { title: label, columns: [], rows: [], stats: [{ label: 'Students', value: n }] } }
  },
}

// --- birthdays --------------------------------------------------------------------------------

/** The dates [from, to] a "when" covers: today, tomorrow, this_week (next 7 days), this_month, or a YYYY-MM-DD. */
export function birthdayWindow(when: string, today: string): { from: string; to: string } | null {
  const w = when.trim().toLowerCase().replace(/\s+/g, '_')
  if (w === '' || w === 'today') return { from: today, to: today }
  if (w === 'tomorrow') { const t = addDays(today, 1); return { from: t, to: t } }
  if (w === 'this_week' || w === 'week' || w === 'next_7_days') return { from: today, to: addDays(today, 6) }
  if (w === 'this_month' || w === 'month') {
    const [y, m] = today.split('-').map(Number)
    return { from: today, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }
  }
  return isDate(when.trim()) ? { from: when.trim(), to: when.trim() } : null
}

/** The date in [from, to] on which a date of birth falls, or null. 29 February is kept on the 28th in a common year. */
export function birthdayIn(dob: unknown, from: string, to: string): string | null {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const md = dob.slice(5, 10)
    if (md === d.slice(5, 10)) return d
    if (md === '02-29' && d.slice(5, 10) === '02-28' && addDays(d, 1).slice(5, 10) === '03-01') return d
  }
  return null
}

const birthdays: ToolSpec = {
  name: 'birthdays', label: 'Finding birthdays',
  description: 'Students and staff whose birthday falls today, tomorrow, this week or this month (from their date of birth), with age and class or designation.',
  params: {
    when: { type: 'STRING', description: 'today (default), tomorrow, this_week, this_month, or YYYY-MM-DD' },
    who: { type: 'STRING', description: 'students, staff or both (default both)', enum: ['students', 'staff', 'both'] },
    class: { type: 'STRING', description: 'Only this class (optional, students only)' },
  },
  offer: (c) => can(c.id, 'students.read') || can(c.id, 'hr.employees.read'),
  run: async (c, a) => {
    const today = indiaToday()
    const win = birthdayWindow(str(a, 'when'), today)
    if (!win) return fail('say today, tomorrow, this_week, this_month or a date YYYY-MM-DD')
    const who = str(a, 'who') || 'both'
    const out: Row[] = []
    const notes: string[] = []
    const age = (dob: string, on: string) => Number(on.slice(0, 4)) - Number(dob.slice(0, 4))
    if (who !== 'staff' && can(c.id, 'students.read') && !isFamily(c)) {
      const q: Record<string, string | number> = { limit: 200, with_total: 0 }
      if (str(a, 'class')) {
        const s = await findSection(c, str(a, 'class'), '')
        if (s.one) q.section_id = s.one.id; else if (s.classOnly) q.class_id = s.classOnly.id; else return fail(s.error!)
      }
      let cursor = ''
      for (let page = 0; page < 25; page++) {
        const g = await readAs(c, '/students', { ...q, cursor })
        if (g.status !== 200) { notes.push('students: ' + refusal(g)); break }
        for (const r of rowsOf(g.data)) {
          const on = birthdayIn(r.date_of_birth, win.from, win.to)
          if (on) out.push({ id: r.id, kind: 'student', name: r.full_name, on, age: age(String(r.date_of_birth), on), about: `${r.class_name ?? ''} ${r.section_name ?? ''}`.trim() })
        }
        cursor = String((g.data as Row).next_cursor ?? '')
        if (!(g.data as Row).has_more || !cursor) break
      }
    }
    if (who !== 'students' && can(c.id, 'hr.employees.read')) {
      const days = Math.round((Date.parse(win.to) - Date.parse(today)) / 86_400_000)
      if (days >= 0) {
        const g = await readAs(c, '/hr/celebrations', { days: Math.max(1, days) })
        if (g.status !== 200) notes.push('staff: ' + refusal(g))
        else for (const r of rowsOf(g.data)) {
          if (r.kind !== 'birthday' || String(r.on_date) < win.from || String(r.on_date) > win.to) continue
          out.push({ id: null, kind: 'staff', name: r.full_name, on: r.on_date, age: r.years, about: r.designation ?? 'Staff' })
        }
      } else notes.push('staff birthdays are listed for today onwards only')
    }
    out.sort((x, y) => String(x.on).localeCompare(String(y.on)) || String(x.name).localeCompare(String(y.name)))
    const range = win.from === win.to ? win.from : `${win.from} to ${win.to}`
    const t = table(`Birthdays, ${range}`, out, [['name', 'Name'], ['kind', 'Who'], ['about', 'Class or role'], ['on', 'On'], ['age', 'Turns']],
      (r) => (r.kind === 'student' ? studentLink(c, String(r.id), '').to : null),
      { stats: [{ label: 'Students', value: out.filter((r) => r.kind === 'student').length }, { label: 'Staff', value: out.filter((r) => r.kind === 'staff').length }] })
    return { ...t, data: { ...(t.data as Row), range, ...(notes.length ? { notes } : {}) } }
  },
}

// --- absent days in a row ---------------------------------------------------------------------

/** Per student, the longest run of consecutive school days marked absent, from days listed newest first. */
export function absenceRuns(days: { date: string; absent: Set<string> }[], min: number): Map<string, { length: number; from: string; to: string; current: boolean }> {
  const out = new Map<string, { length: number; from: string; to: string; current: boolean }>()
  const ordered = [...days].sort((x, y) => x.date.localeCompare(y.date))
  const run = new Map<string, { length: number; from: string }>()
  ordered.forEach((d, i) => {
    for (const [id, r] of run) if (!d.absent.has(id)) run.delete(id)
    for (const id of d.absent) {
      const r = run.get(id) ?? { length: 0, from: d.date }
      r.length++
      run.set(id, r)
      const best = out.get(id)
      if (r.length >= min && (!best || r.length >= best.length)) out.set(id, { length: r.length, from: r.from, to: d.date, current: i === ordered.length - 1 })
    }
  })
  return out
}

const consecutiveAbsences: ToolSpec = {
  name: 'consecutive_absences', label: 'Looking for absences in a row',
  description: 'Students marked absent on several school days in a row (default 3) within the last few weeks, over the sections the person may see; says whether the run is still going today.',
  params: {
    days: { type: 'INTEGER', description: 'How many school days in a row, default 3' },
    lookback: { type: 'INTEGER', description: 'How many calendar days back to look, default 21, at most 45' },
    class: { type: 'STRING', description: 'Only this class (optional)' }, section: { type: 'STRING', description: 'Section (optional)' },
  },
  offer: (c) => can(c.id, 'academics.attendance.read') || can(c.id, 'academics.attendance.read.all'),
  run: async (c, a) => {
    const min = Math.max(2, Math.min(15, num(a, 'days') ?? 3))
    const back = Math.max(min, Math.min(45, num(a, 'lookback') ?? 21))
    let sectionId = ''
    if (str(a, 'class')) {
      const s = await findSection(c, str(a, 'class'), str(a, 'section'))
      if (!s.one) { if (!s.classOnly) return fail(s.error!) } else sectionId = s.one.id
    }
    const today = indiaToday()
    const cls = str(a, 'class') && !sectionId ? bare(str(a, 'class')) : ''
    const days: { date: string; absent: Set<string> }[] = []
    const who = new Map<string, Row>()
    for (let i = 0; i <= back; i++) {
      const date = addDays(today, -i)
      const g = await readAs(c, '/attendance/absentees', { on_date: date, section_id: sectionId })
      if (g.status !== 200) return fail(refusal(g))
      const d = g.data as { sections?: Row[]; present?: Row[] }
      const present = (d.present ?? []).filter((p) => !cls || bare(String(p.class_name ?? '')) === cls)
      const absent = new Set<string>()
      for (const sec of d.sections ?? []) {
        if (cls && bare(String(sec.class_name ?? '')) !== cls) continue
        for (const st of (sec.students ?? []) as Row[]) {
          if (st.mark !== 'absent') continue
          absent.add(String(st.student_id))
          who.set(String(st.student_id), { name: st.name, class: `${sec.class_name} ${sec.section_name}`, informed: st.informed ? 'yes' : '' })
        }
      }
      // A day nobody was marked on is a holiday or a register not taken: it neither breaks nor extends a run.
      if (absent.size || present.length) days.push({ date, absent })
    }
    const runs = absenceRuns(days, min)
    const rows = [...runs.entries()].map(([id, r]): Row & { days: number } => ({ student_id: id, ...who.get(id), days: r.length, from: r.from, to: r.to, still: r.current ? 'yes' : '' }))
      .sort((x, y) => y.days - x.days || String(x.name).localeCompare(String(y.name)))
    return { ...table(`Absent ${min}+ school days in a row`, rows, [['name', 'Student'], ['class', 'Class'], ['days', 'Days'], ['from', 'From'], ['to', 'To'], ['still', 'Still away'], ['informed', 'Parent told school']],
      (r) => studentLink(c, String(r.student_id), '').to, { stats: [{ label: 'Students', value: rows.length }, { label: 'School days checked', value: days.length }] }),
      links: [screenLink('absentee_followup', 'Absentee follow-up')] }
  },
}

export const SCHOOL_TOOLS: ToolSpec[] = [classSections, studentCount, birthdays, consecutiveAbsences]
