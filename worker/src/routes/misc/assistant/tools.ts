import type { Ctx } from '../../../router'
import { can } from '../../../identity'
import { indiaToday } from '../../students/common'
import {
  MAX_ROWS, findSection, findStudent, flat, isDate, isFamily, num, readAs, refusal, rowsOf, rupees, screenLink, str, studentLink,
  type Link,
} from './read'

/* THE READ TOOLS THE MODEL MAY CALL.

   Fixed functions with typed parameters: the model picks a tool and fills its
   arguments, and the tool reads through one of the Worker's own routes as the
   caller (read.ts). No SQL, no paths and no ids of other schools can come from
   the model: each school's data lives in its own database, and the routes
   check permission and scope exactly as they do for the screens. Every answer
   is capped at MAX_ROWS rows, and carries a compact view the chat draws as a
   table, plus links to the records it names. */

export interface View {
  title: string
  columns: string[]
  rows: (string | number)[][]
  /** Per row, the record it opens; null for none. */
  row_links?: (string | null)[]
  total?: number
  stats?: { label: string; value: string | number }[]
}
export interface ToolResult { data: unknown; view?: View; links?: Link[]; error?: string }
type Args = Record<string, unknown>

interface Param { type: 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN' | 'ARRAY'; description: string; enum?: string[]; items?: { type: 'STRING' } }
export interface ToolSpec {
  name: string
  /** What the chat shows while it runs: "Looking up …". */
  label: string
  description: string
  params: Record<string, Param>
  required?: string[]
  /** Offered to the model only when the caller could possibly use it. */
  offer: (c: Ctx) => boolean
  run: (c: Ctx, a: Args) => Promise<ToolResult>
}

const fail = (error: string): ToolResult => ({ data: { error }, error })
const cell = (v: unknown): string | number => (v === null || v === undefined ? '' : typeof v === 'number' ? v : String(v))

/** A capped table for the model and the chat alike. */
function table(title: string, rows: Record<string, unknown>[], cols: [string, string][], link?: (r: Record<string, unknown>) => string | null,
  extra: Partial<View> = {}): { view: View; data: unknown } {
  const shown = rows.slice(0, MAX_ROWS)
  const view: View = { title, columns: cols.map((c) => c[1]), rows: shown.map((r) => cols.map(([k]) => cell(r[k]))), total: rows.length, ...extra }
  if (link) view.row_links = shown.map(link)
  return { view, data: { total: rows.length, shown: shown.length, rows: shown.map(flat), ...(extra.stats ? { stats: extra.stats } : {}) } }
}

async function oneStudent(c: Ctx, a: Args): Promise<{ id: string; name: string } | ToolResult> {
  const f = await findStudent(c, str(a, 'student'))
  if (f.error) return fail(f.error)
  if (f.many) return { data: { ambiguous: true, candidates: f.many }, error: undefined }
  return { id: f.one!.id, name: f.one!.name }
}
const isResult = (x: unknown): x is ToolResult => !!x && typeof x === 'object' && 'data' in x

// --- students -------------------------------------------------------------------------------

const searchStudents: ToolSpec = {
  name: 'search_students', label: 'Searching students',
  description: 'Find students the person may see, by name, admission number, or class and section. Returns name, admission number, class, section.',
  params: {
    query: { type: 'STRING', description: 'Name or admission number; empty to list a class' },
    class: { type: 'STRING', description: 'Class, e.g. "6" or "Class 6" (optional)' },
    section: { type: 'STRING', description: 'Section, e.g. "A" (optional)' },
  },
  offer: (c) => can(c.id, 'students.read') || isFamily(c),
  run: async (c, a) => {
    let rows: Record<string, unknown>[]
    if (isFamily(c)) {
      const g = await readAs(c, '/portal/students')
      if (g.status !== 200) return fail(refusal(g))
      const q = str(a, 'query').toLowerCase()
      rows = rowsOf(g.data).map((r): Record<string, unknown> => ({ ...r, id: r.id ?? r.student_id, full_name: r.full_name ?? r.name }))
        .filter((r) => q === '' || String(r.full_name).toLowerCase().includes(q) || String(r.admission_no ?? '').toLowerCase() === q)
    } else {
      let sectionId = '', classId = ''
      if (str(a, 'class') || str(a, 'section')) {
        const s = await findSection(c, str(a, 'class'), str(a, 'section'))
        if (s.one) sectionId = s.one.id
        else if (s.classOnly) classId = s.classOnly.id
        else return fail(s.error!)
      }
      const g = await readAs(c, '/students', { q: str(a, 'query'), section_id: sectionId, class_id: classId, limit: 100, with_total: 1 })
      if (g.status !== 200) return fail(refusal(g))
      rows = rowsOf(g.data)
    }
    const t = table('Students', rows, [['full_name', 'Name'], ['admission_no', 'Adm no'], ['class_name', 'Class'], ['section_name', 'Section']],
      (r) => studentLink(c, String(r.id), '').to)
    return { ...t }
  },
}

const studentProfile: ToolSpec = {
  name: 'student_profile', label: 'Opening the student record',
  description: "One student's record: class, roll number, guardians and phones, attendance percentage this year, fees outstanding.",
  params: { student: { type: 'STRING', description: 'Name, admission number or id' } },
  required: ['student'],
  offer: (c) => can(c.id, 'students.read') || isFamily(c),
  run: async (c, a) => {
    const s = await oneStudent(c, a)
    if (isResult(s)) return s
    if (isFamily(c)) {
      const g = await readAs(c, '/portal/summary', { student_id: s.id })
      if (g.status !== 200) return fail(refusal(g))
      const d = flat(g.data)
      return { data: { student: s.name, ...d }, links: [studentLink(c, s.id, s.name)],
        view: { title: s.name, columns: ['Field', 'Value'], rows: Object.entries(d).filter(([k]) => !k.endsWith('id')).slice(0, 14).map(([k, v]) => [k.replace(/_/g, ' '), cell(v)]) } }
    }
    const g = await readAs(c, `/students/${s.id}/profile`)
    if (g.status !== 200) return fail(refusal(g))
    const p = g.data as Record<string, any>
    const guardians = Array.isArray(p.guardians) ? p.guardians.slice(0, 4).map((x: any) => `${x.full_name} (${x.relation}${x.phone ? ', ' + x.phone : ''})`) : []
    const att = p.attendance ?? {}, fees = p.fees ?? {}
    const data = {
      id: p.id, name: p.full_name, admission_no: p.admission_no, status: p.status, class: p.class_name, section: p.section_name, roll_no: p.roll_no,
      attendance: `${att.percent ?? 0}% (${att.present ?? 0} of ${att.total ?? 0} days)${att.below_threshold ? ', below threshold' : ''}`,
      fees_outstanding: rupees(fees.outstanding_paise), fees_paid: rupees(fees.paid_paise), guardians,
    }
    return {
      data, links: [studentLink(c, s.id, String(p.full_name))],
      view: { title: String(p.full_name), columns: ['Field', 'Value'], rows: [
        ['Admission no', cell(p.admission_no)], ['Class', `${p.class_name ?? ''} ${p.section_name ?? ''}`.trim()], ['Roll no', cell(p.roll_no)],
        ['Attendance', data.attendance], ['Fees outstanding', data.fees_outstanding], ['Guardians', guardians.join('; ')],
      ] },
    }
  },
}

const studentMarks: ToolSpec = {
  name: 'student_marks', label: 'Reading marks',
  description: "A student's marks by subject for an exam (the latest if none is named), with percentage, grade and rank where published.",
  params: { student: { type: 'STRING', description: 'Name, admission number or id' }, exam: { type: 'STRING', description: 'Exam name, e.g. "Half yearly" (optional)' } },
  required: ['student'],
  offer: (c) => can(c.id, 'academics.exams.read') || isFamily(c),
  run: async (c, a) => {
    const s = await oneStudent(c, a)
    if (isResult(s)) return s
    const exam = str(a, 'exam').toLowerCase()
    if (isFamily(c)) {
      const g = await readAs(c, '/portal/results', { student_id: s.id })
      if (g.status !== 200) return fail(refusal(g))
      const marks = (Array.isArray((g.data as any).marks) ? (g.data as any).marks : rowsOf(g.data)) as Record<string, unknown>[]
      const rows = marks.filter((m) => !exam || String(m.exam ?? '').toLowerCase().includes(exam))
      return { ...table(`${s.name}: marks`, rows, [['exam', 'Exam'], ['subject', 'Subject'], ['obtained', 'Marks'], ['max', 'Out of'], ['grade', 'Grade']]),
        links: [screenLink('results_report_cards', 'Results', 'student_id=' + s.id)] }
    }
    // Staff: the papers the person may read, then each paper's gradebook row for this child.
    const exams = await readAs(c, '/exams/list')
    if (exams.status !== 200) return fail(refusal(exams))
    const ex = rowsOf(exams.data).find((e) => !exam || String(e.name).toLowerCase().includes(exam))
    if (!ex) return fail(exam ? `no exam called "${str(a, 'exam')}"` : 'no exams yet')
    const papers = await readAs(c, '/exams/subjects', { exam_id: String(ex.id) })
    if (papers.status !== 200) return fail(refusal(papers))
    const rows: Record<string, unknown>[] = []
    for (const p of rowsOf(papers.data).slice(0, 15)) {
      const gb = await readAs(c, '/exams/gradebook', { exam_subject_id: String(p.id) })
      const r = rowsOf(gb.data).find((x) => x.student_id === s.id)
      if (r) rows.push({ subject: p.subject, marks: r.is_absent ? 'absent' : r.marks_obtained ?? '', max: r.max_marks, grade: r.grade ?? '' })
    }
    if (rows.length === 0) return fail(`no ${ex.name} marks the person asking can see for ${s.name}`)
    return { ...table(`${s.name}: ${ex.name}`, rows, [['subject', 'Subject'], ['marks', 'Marks'], ['max', 'Out of'], ['grade', 'Grade']]),
      links: [studentLink(c, s.id, s.name)] }
  },
}

const studentAttendance: ToolSpec = {
  name: 'student_attendance', label: 'Reading attendance',
  description: "A student's attendance: days present, absent, percentage, and recent absences.",
  params: { student: { type: 'STRING', description: 'Name, admission number or id' } },
  required: ['student'],
  offer: (c) => can(c.id, 'students.read') || isFamily(c),
  run: async (c, a) => {
    const s = await oneStudent(c, a)
    if (isResult(s)) return s
    if (isFamily(c)) {
      const g = await readAs(c, '/portal/attendance', { student_id: s.id })
      if (g.status !== 200) return fail(refusal(g))
      const rows = rowsOf(g.data)
      const absent = rows.filter((r) => String(r.status) === 'absent')
      const present = rows.filter((r) => ['present', 'late'].includes(String(r.status))).length
      const stats = [{ label: 'Present', value: present }, { label: 'Absent', value: absent.length },
        { label: 'Percent', value: rows.length ? Math.round((100 * present) / rows.length) + '%' : '-' }]
      return { ...table(`${s.name}: absences`, absent, [['on_date', 'Date'], ['status', 'Mark'], ['remarks', 'Remarks']], undefined, { stats }) }
    }
    const g = await readAs(c, `/students/${s.id}/profile`)
    if (g.status !== 200) return fail(refusal(g))
    const at = (g.data as any).attendance ?? {}
    const stats = [{ label: 'Present', value: at.present ?? 0 }, { label: 'Days', value: at.total ?? 0 }, { label: 'Percent', value: `${at.percent ?? 0}%` }]
    return { data: { student: s.name, ...at }, view: { title: `${s.name}: attendance`, columns: [], rows: [], stats }, links: [studentLink(c, s.id, s.name)] }
  },
}

// --- attendance -----------------------------------------------------------------------------

const sectionAttendance: ToolSpec = {
  name: 'section_attendance', label: 'Reading the register',
  description: "A class section's register for a day: how many present, absent, late, not marked, and who was absent.",
  params: { class: { type: 'STRING', description: 'Class, e.g. "5"' }, section: { type: 'STRING', description: 'Section, e.g. "A"' }, date: { type: 'STRING', description: 'YYYY-MM-DD, default today' } },
  required: ['class'],
  offer: (c) => can(c.id, 'academics.attendance.read'),
  run: async (c, a) => {
    const s = await findSection(c, str(a, 'class'), str(a, 'section'))
    if (!s.one) return fail(s.error!)
    const date = str(a, 'date') || indiaToday()
    if (!isDate(date)) return fail('the date must be YYYY-MM-DD')
    const g = await readAs(c, '/attendance', { section_id: s.one.id, on_date: date })
    if (g.status !== 200) return fail(refusal(g))
    const rows = rowsOf(g.data)
    const count: Record<string, number> = {}
    for (const r of rows) count[String(r.status)] = (count[String(r.status)] ?? 0) + 1
    const away = rows.filter((r) => r.status !== 'present')
    const stats = Object.entries(count).map(([k, v]) => ({ label: k.replace('_', ' '), value: v }))
    if (rows.length === 0) stats.push({ label: 'marked', value: 0 })
    return { ...table(`${s.one.label}, ${date}`, away, [['student_name', 'Student'], ['admission_no', 'Adm no'], ['status', 'Mark']],
      (r) => studentLink(c, String(r.student_id), '').to, { stats }), links: [screenLink('take_attendance', 'Take attendance')] }
  },
}

const absentees: ToolSpec = {
  name: 'absentees', label: 'Finding absentees',
  description: 'Students marked absent (or late, half day) on a day across the sections the person may see, with the follow-up call status.',
  params: { date: { type: 'STRING', description: 'YYYY-MM-DD, default today' }, class: { type: 'STRING', description: 'Limit to a class (optional)' }, section: { type: 'STRING', description: 'Section (optional)' } },
  offer: (c) => can(c.id, 'academics.attendance.read') || can(c.id, 'academics.attendance.read.all'),
  run: async (c, a) => {
    const date = str(a, 'date') || indiaToday()
    if (!isDate(date)) return fail('the date must be YYYY-MM-DD')
    let sectionId = ''
    if (str(a, 'class')) { const s = await findSection(c, str(a, 'class'), str(a, 'section')); if (!s.one) return fail(s.error!); sectionId = s.one.id }
    const g = await readAs(c, '/attendance/absentees', { on_date: date, section_id: sectionId })
    if (g.status !== 200) return fail(refusal(g))
    const rows: Record<string, unknown>[] = []
    for (const sec of ((g.data as any).sections ?? []) as any[]) for (const st of sec.students ?? []) {
      rows.push({ student_id: st.student_id, name: st.name, admission_no: st.admission_no, class: `${sec.class_name} ${sec.section_name}`, mark: st.mark, call: st.call_status })
    }
    const present = Array.isArray((g.data as any).present) ? (g.data as any).present.length : 0
    return { ...table(`Absent on ${date}`, rows, [['name', 'Student'], ['class', 'Class'], ['mark', 'Mark'], ['call', 'Call home']],
      (r) => studentLink(c, String(r.student_id), '').to, { stats: [{ label: 'Absent', value: rows.length }, { label: 'Present', value: present }] }),
      links: [screenLink('absentee_followup', 'Absentee follow-up')] }
  },
}

const attendanceTrend: ToolSpec = {
  name: 'attendance_trend', label: 'Reading the attendance trend',
  description: 'School-wide daily attendance percentage over recent days.',
  params: {},
  offer: (c) => can(c.id, 'admin.reports.read'),
  run: async (c) => {
    const g = await readAs(c, '/principal/attendance-trend')
    if (g.status !== 200) return fail(refusal(g))
    const rows = rowsOf(g.data).slice(-MAX_ROWS)
    return table('Attendance trend', rows, [['date', 'Date'], ['present', 'Present'], ['absent', 'Absent'], ['pct', '%']])
  },
}

// --- fees -----------------------------------------------------------------------------------

const feeDefaulters: ToolSpec = {
  name: 'fee_defaulters', label: 'Listing fee defaulters',
  description: 'Students with overdue fees, largest balance first, with guardian phone and days overdue. Filter by class, minimum balance in rupees, or minimum days overdue.',
  params: {
    class: { type: 'STRING', description: 'Class name, e.g. "8" (optional)' },
    min_balance: { type: 'NUMBER', description: 'Only balances at least this many rupees (optional)' },
    min_days_overdue: { type: 'INTEGER', description: 'Only dues overdue at least this many days (optional)' },
    include_not_yet_due: { type: 'BOOLEAN', description: 'Also count unpaid invoices not yet due (optional)' },
  },
  offer: (c) => can(c.id, 'finance.invoices.read'),
  run: async (c, a) => {
    const g = await readAs(c, '/fees/defaulters', { all: a.include_not_yet_due === true ? 1 : undefined })
    if (g.status !== 200) return fail(refusal(g))
    const rows = filterDefaulters(rowsOf(g.data), a)
    const total = rows.reduce((s, r) => s + Number(r.balance_paise ?? 0), 0)
    const shaped = rows.map((r) => ({ ...r, balance: rupees(r.balance_paise), class: `${r.class_name ?? ''} ${r.section_name ?? ''}`.trim() }))
    return { ...table('Fee defaulters', shaped, [['full_name', 'Student'], ['class', 'Class'], ['balance', 'Balance'], ['days_overdue', 'Days overdue'], ['phone', 'Phone']],
      (r) => studentLink(c, String(r.student_id), '').to, { stats: [{ label: 'Families', value: rows.length }, { label: 'Outstanding', value: rupees(total) }] }),
      links: [screenLink('fee_default', 'Fee defaulters')] }
  },
}

export function filterDefaulters(rows: Record<string, unknown>[], a: Args): Record<string, unknown>[] {
  const cls = str(a, 'class').toLowerCase().replace(/^(class|grade)\s*/, '')
  const minBal = num(a, 'min_balance'), minDays = num(a, 'min_days_overdue')
  return rows.filter((r) =>
    (cls === '' || String(r.class_name ?? '').toLowerCase().replace(/^(class|grade)\s*/, '') === cls) &&
    (minBal === null || Number(r.balance_paise ?? 0) >= minBal * 100) &&
    (minDays === null || Number(r.days_overdue ?? 0) >= minDays))
}

const feeLedger: ToolSpec = {
  name: 'student_fee_ledger', label: 'Opening the fee ledger',
  description: "A student's fee account: charged, paid, balance, what is due and recent invoices and payments.",
  params: { student: { type: 'STRING', description: 'Name, admission number or id' } },
  required: ['student'],
  offer: (c) => can(c.id, 'finance.fees.read') || can(c.id, 'finance.invoices.read') || isFamily(c),
  run: async (c, a) => {
    const s = await oneStudent(c, a)
    if (isResult(s)) return s
    const g = await readAs(c, `/fees/students/${s.id}/ledger`)
    if (g.status !== 200) return fail(refusal(g))
    const d = g.data as Record<string, any>
    const entries = (Array.isArray(d.entries) ? d.entries : []).slice(-MAX_ROWS).map((e: any) => ({ ...e, debit: e.debit_paise ? rupees(e.debit_paise) : '', credit: e.credit_paise ? rupees(e.credit_paise) : '' }))
    const stats = [{ label: 'Charged', value: rupees(d.charged_paise) }, { label: 'Paid', value: rupees(d.paid_paise) }, { label: 'Balance', value: rupees(d.balance_paise) }]
    return { ...table(`${d.full_name ?? s.name}: fees`, entries, [['date', 'Date'], ['description', 'What'], ['debit', 'Charged'], ['credit', 'Paid'], ['status', 'Status']], undefined, { stats }),
      links: [isFamily(c) ? screenLink('fees_payments', 'Fees', 'student_id=' + s.id) : screenLink('fee_collection', 'Fee counter', 'student=' + s.id)] }
  },
}

const feeCollections: ToolSpec = {
  name: 'fee_collections', label: 'Summing collections',
  description: 'Fee money collected, by day or month, between two dates (default this month), split by cash, cheque and online.',
  params: { from: { type: 'STRING', description: 'YYYY-MM-DD (optional)' }, to: { type: 'STRING', description: 'YYYY-MM-DD (optional)' }, group: { type: 'STRING', description: 'day or month', enum: ['day', 'month'] } },
  offer: (c) => can(c.id, 'finance.payments.read'),
  run: async (c, a) => {
    const from = str(a, 'from'), to = str(a, 'to')
    const g = await readAs(c, '/rollups/fees/collections', { from: isDate(from) ? from : undefined, to: isDate(to) ? to : undefined, period: from && to ? undefined : 'this_month', group: str(a, 'group') || 'day' })
    if (g.status !== 200) return fail(refusal(g))
    const rows = rowsOf(g.data)
    const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
    const total = sum('cash_paise') + sum('cheque_paise') + sum('online_paise')
    const shaped = rows.map((r) => ({ ...r, cash: rupees(r.cash_paise), cheque: rupees(r.cheque_paise), online: rupees(r.online_paise) }))
    return table('Collections', shaped, [['bucket', 'Period'], ['receipts', 'Receipts'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['online', 'Online']], undefined,
      { stats: [{ label: 'Collected', value: rupees(total) }, { label: 'Receipts', value: sum('receipts') }] })
  },
}

// --- exams ----------------------------------------------------------------------------------

const examResults: ToolSpec = {
  name: 'exam_results', label: 'Analysing results',
  description: 'For an exam (latest if none named), per-subject averages and pass rates, and the top students by total, over the papers the person may see. Optionally one class or subject.',
  params: {
    exam: { type: 'STRING', description: 'Exam name (optional)' }, class: { type: 'STRING', description: 'Class (optional)' },
    subject: { type: 'STRING', description: 'Subject (optional)' }, top: { type: 'INTEGER', description: 'How many toppers, default 5' },
  },
  offer: (c) => can(c.id, 'academics.exams.read'),
  run: async (c, a) => {
    const exams = await readAs(c, '/exams/list')
    if (exams.status !== 200) return fail(refusal(exams))
    const want = str(a, 'exam').toLowerCase()
    const ex = rowsOf(exams.data).find((e) => !want || String(e.name).toLowerCase().includes(want))
    if (!ex) return fail(want ? `no exam called "${str(a, 'exam')}"` : 'no exams yet')
    let classId = ''
    if (str(a, 'class')) { const s = await findSection(c, str(a, 'class'), ''); classId = s.one?.class_id ?? s.classOnly?.id ?? ''; if (!classId) return fail(s.error!) }
    const papers = await readAs(c, '/exams/subjects', { exam_id: String(ex.id), class_id: classId })
    if (papers.status !== 200) return fail(refusal(papers))
    const subj = str(a, 'subject').toLowerCase()
    const list = rowsOf(papers.data).filter((p) => !subj || String(p.subject).toLowerCase().includes(subj)).slice(0, 20)
    const subjects: Record<string, unknown>[] = []
    const totals = new Map<string, { name: string; got: number; max: number; id: string }>()
    for (const p of list) {
      const gb = await readAs(c, '/exams/gradebook', { exam_subject_id: String(p.id) })
      if (gb.status !== 200) continue
      const sat = rowsOf(gb.data).filter((r) => r.marks_obtained !== undefined && r.marks_obtained !== null && !r.is_absent)
      const max = Number(p.max_marks ?? 0)
      const avg = sat.length ? sat.reduce((s, r) => s + Number(r.marks_obtained), 0) / sat.length : 0
      const passed = sat.filter((r) => max > 0 && Number(r.marks_obtained) >= max * 0.33).length
      subjects.push({ subject: `${p.subject} (${p.class_name})`, sat: sat.length, average: max ? `${Math.round((100 * avg) / max)}%` : '', pass_rate: sat.length ? `${Math.round((100 * passed) / sat.length)}%` : '' })
      for (const r of sat) {
        const t = totals.get(String(r.student_id)) ?? { name: String(r.full_name), got: 0, max: 0, id: String(r.student_id) }
        t.got += Number(r.marks_obtained); t.max += max
        totals.set(String(r.student_id), t)
      }
    }
    if (subjects.length === 0) return fail(`no ${ex.name} papers the person asking can see`)
    const top = Math.max(1, Math.min(10, num(a, 'top') ?? 5))
    const toppers = [...totals.values()].sort((x, y) => y.got / (y.max || 1) - x.got / (x.max || 1)).slice(0, top)
      .map((t, i) => ({ rank: i + 1, student_id: t.id, name: t.name, total: `${t.got} / ${t.max}`, percent: t.max ? `${Math.round((1000 * t.got) / t.max) / 10}%` : '' }))
    const t = table(`${ex.name}: subjects`, subjects, [['subject', 'Subject'], ['sat', 'Sat'], ['average', 'Average'], ['pass_rate', 'Passed']])
    return {
      data: { exam: ex.name, subjects: (t.data as any).rows, toppers },
      view: { ...t.view, stats: toppers.map((x) => ({ label: `#${x.rank} ${x.name}`, value: x.percent })) },
      links: [screenLink('exams_results', 'Results'), ...toppers.slice(0, 3).map((x) => studentLink(c, x.student_id, x.name))],
    }
  },
}

// --- staff ----------------------------------------------------------------------------------

const staffDirectory: ToolSpec = {
  name: 'staff_directory', label: 'Searching staff',
  description: 'Staff on the roll by name, department or designation, with phone and email.',
  params: { query: { type: 'STRING', description: 'Name, department or designation (optional)' } },
  offer: (c) => can(c.id, 'hr.employees.read'),
  run: async (c, a) => {
    const g = await readAs(c, '/hr/employees', { limit: 200, status: 'active', with_total: 0 })
    if (g.status !== 200) return fail(refusal(g))
    const q = str(a, 'query').toLowerCase()
    const rows = rowsOf(g.data).filter((r) => !q || [r.full_name, r.department, r.designation, r.employee_code].some((v) => String(v ?? '').toLowerCase().includes(q)))
    return { ...table('Staff', rows, [['full_name', 'Name'], ['designation', 'Designation'], ['department', 'Department'], ['phone', 'Phone']]),
      links: [screenLink('staff_records', 'Staff records')] }
  },
}

const staffLeave: ToolSpec = {
  name: 'leave_requests', label: 'Reading leave requests',
  description: 'Leave requests (staff or student), by status. Pending ones can be approved or rejected with propose_leave_decide.',
  params: { status: { type: 'STRING', description: 'pending, approved or rejected (optional)', enum: ['pending', 'approved', 'rejected'] }, for: { type: 'STRING', description: 'staff or student (optional)', enum: ['staff', 'student'] } },
  offer: () => true,
  run: async (c, a) => {
    const g = await readAs(c, '/hr/leave', { status: str(a, 'status'), for: str(a, 'for') })
    if (g.status !== 200) return fail(refusal(g))
    return { ...table('Leave requests', rowsOf(g.data), [['who', 'Who'], ['leave_type', 'Type'], ['from_date', 'From'], ['to_date', 'To'], ['days', 'Days'], ['status', 'Status']]),
      links: [screenLink('leave', 'Leave')] }
  },
}

const staffAway: ToolSpec = {
  name: 'staff_away_today', label: "Checking who's away",
  description: 'Staff absent or on leave today, with headcount, present count and pending leave.',
  params: {},
  offer: (c) => can(c.id, 'hr.employees.read'),
  run: async (c) => {
    const g = await readAs(c, '/hr/dashboard')
    if (g.status !== 200) return fail(refusal(g))
    const d = g.data as Record<string, any>
    const stats = [{ label: 'Headcount', value: d.headcount ?? 0 }, { label: 'Present', value: d.present_today ?? 0 }, { label: 'Absent', value: d.absent_today ?? 0 }, { label: 'Leave pending', value: d.leave_pending ?? 0 }]
    return { ...table('Away today', Array.isArray(d.away_today) ? d.away_today : [], [['name', 'Name'], ['reason', 'Why'], ['until', 'Until']], undefined, { stats }) }
  },
}

// --- timetable ------------------------------------------------------------------------------

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const timetable: ToolSpec = {
  name: 'timetable', label: 'Reading the timetable',
  description: "A class section's or a teacher's periods for a day (today if none). Give a class and section, or a teacher's name, or neither for the asker's own.",
  params: {
    class: { type: 'STRING', description: 'Class (optional)' }, section: { type: 'STRING', description: 'Section (optional)' },
    teacher: { type: 'STRING', description: "Teacher's name (optional)" }, day: { type: 'STRING', description: 'monday..saturday or YYYY-MM-DD (optional)' },
  },
  offer: (c) => can(c.id, 'academics.timetable.read'),
  run: async (c, a) => {
    const q: Record<string, string> = {}
    let title = 'My timetable'
    if (str(a, 'class')) {
      const s = await findSection(c, str(a, 'class'), str(a, 'section'))
      if (!s.one) return fail(s.error!)
      q.section_id = s.one.id; title = s.one.label
    } else if (str(a, 'teacher')) {
      const t = await readAs(c, '/timetable/teachers')
      if (t.status !== 200) return fail(refusal(t))
      const want = str(a, 'teacher').toLowerCase()
      const hit = rowsOf(t.data).filter((r) => String(r.full_name ?? r.name ?? '').toLowerCase().includes(want))
      if (hit.length === 0) return fail(`no teacher called "${str(a, 'teacher')}"`)
      q.teacher_id = String(hit[0].user_id); title = String(hit[0].full_name ?? hit[0].name)
    } else {
      q.teacher_id = 'me'
    }
    let day = str(a, 'day').toLowerCase()
    if (isDate(day)) day = DAYS[(new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7]
    if (day === '' || day === 'today') day = DAYS[(new Date(indiaToday() + 'T00:00:00Z').getUTCDay() + 6) % 7]
    const wd = DAYS.indexOf(day) + 1
    const g = await readAs(c, '/timetable/entries', q)
    if (g.status !== 200) return fail(refusal(g))
    const rows = rowsOf(g.data).filter((r) => wd === 0 || Number(r.weekday) === wd)
      .map((r) => ({ ...r, class: `${r.class_name ?? ''} ${r.section_name ?? ''}`.trim() }))
    return { ...table(`${title}, ${day}`, rows, [['period_name', 'Period'], ['subject_name', 'Subject'], ['class', 'Class'], ['teacher_name', 'Teacher'], ['room', 'Room']]),
      links: [screenLink('my_timetable', 'Timetable')] }
  },
}

// --- admissions, notices ------------------------------------------------------------------------

const admissions: ToolSpec = {
  name: 'admissions_pipeline', label: 'Reading the admissions pipeline',
  description: 'Admissions funnel: enquiries, applications, assessed, offered, enrolled, and follow-ups due.',
  params: {},
  offer: (c) => can(c.id, 'admissions.read'),
  run: async (c) => {
    const [f, d] = await Promise.all([readAs(c, '/admissions/workflow/funnel'), readAs(c, '/admissions/dashboard')])
    if (f.status !== 200) return fail(refusal(f))
    const dd = d.status === 200 ? flat(d.data) : {}
    return { ...table('Admissions pipeline', rowsOf(f.data), [['stage', 'Stage'], ['count', 'Count']], undefined,
      { stats: Object.entries(dd).slice(0, 6).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: v as number })) }),
      links: [screenLink('admissions_pipeline', 'Admissions pipeline')] }
  },
}

const notices: ToolSpec = {
  name: 'notices', label: 'Reading notices',
  description: 'Recent circulars and notices the person can see, with how many acknowledged.',
  params: { query: { type: 'STRING', description: 'Words in the title (optional)' } },
  offer: () => true,
  run: async (c, a) => {
    const g = await readAs(c, '/communication/circulars')
    if (g.status !== 200) return fail(refusal(g))
    const q = str(a, 'query').toLowerCase()
    const rows = rowsOf(g.data).filter((r) => !q || String(r.title ?? '').toLowerCase().includes(q))
    return { ...table('Notices', rows, [['title', 'Title'], ['audience_role', 'To'], ['published_at', 'Published'], ['acknowledgements', 'Acks']]),
      links: [screenLink('circulars', 'Circulars')] }
  },
}

export const READ_TOOLS: ToolSpec[] = [
  searchStudents, studentProfile, studentAttendance, studentMarks,
  sectionAttendance, absentees, attendanceTrend,
  feeDefaulters, feeLedger, feeCollections,
  examResults, staffDirectory, staffLeave, staffAway, timetable, admissions, notices,
]
